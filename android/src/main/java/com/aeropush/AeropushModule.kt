package com.aeropush

import android.content.Context
import android.content.SharedPreferences
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.ZipInputStream

/**
 * AeroPush Android Turbo Module.
 *
 * Extends the Codegen-generated [NativeAeropushSpec] abstract class (package
 * com.aeropush, NAME = "Aeropush"), which is produced at build time from
 * src/NativeAeropush.ts. Implemented with the Android/JDK standard library
 * only — no OkHttp, no third-party zip lib — so the SDK stays dependency-free.
 *
 * The native-to-native launcher entry points used by MainApplication BEFORE
 * the JS runtime exists live in the companion object (see Launcher API), so
 * they can be called without instantiating the TurboModule.
 */
class AeropushModule(reactContext: ReactApplicationContext) :
  NativeAeropushSpec(reactContext) {

  private val appContext: Context = reactContext.applicationContext

  private fun prefs(): SharedPreferences =
    appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ─── Bundle path resolution ──────────────────────────────────────────

  override fun getActiveBundlePath(): String {
    return activeBundlePath(appContext) ?: ""
  }

  override fun setActiveBundlePath(path: String, promise: Promise) {
    try {
      val p = prefs()
      // Remember current as rollback target before overwriting.
      p.getString(KEY_ACTIVE, null)?.let { current ->
        p.edit().putString(KEY_PREVIOUS, current).apply()
      }
      p.edit()
        .putString(KEY_ACTIVE, path)
        .putInt(KEY_FAIL_COUNT, 0) // fresh bundle: reset attempts
        .apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_SET_BUNDLE", e.message, e)
    }
  }

  override fun clearActiveBundlePath(promise: Promise) {
    try {
      val p = prefs()
      p.getString(KEY_ACTIVE, null)?.let { current ->
        p.edit().putString(KEY_PREVIOUS, current).apply()
      }
      p.edit()
        .remove(KEY_ACTIVE)
        .putInt(KEY_FAIL_COUNT, 0)
        .apply()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_CLEAR_BUNDLE", e.message, e)
    }
  }

  // ─── File download (HttpURLConnection, streamed to disk) ─────────────

  override fun downloadFile(
    url: String,
    destPath: String,
    headers: ReadableMap,
    promise: Promise
  ) {
    // Run off the JS/native module thread so we never block it on network.
    Thread {
      var connection: HttpURLConnection? = null
      try {
        val dest = File(destPath)
        dest.parentFile?.mkdirs()

        connection = (URL(url).openConnection() as HttpURLConnection).apply {
          requestMethod = "GET"
          connectTimeout = 30_000
          readTimeout = 30_000
          val it = headers.entryIterator
          while (it.hasNext()) {
            val entry = it.next()
            (entry.value as? String)?.let { v ->
              setRequestProperty(entry.key, v)
            }
          }
        }
        connection.connect()

        val code = connection.responseCode
        if (code !in 200..299) {
          promise.reject("E_DOWNLOAD_HTTP", "HTTP $code for $url")
          return@Thread
        }

        val total = connection.contentLength.toLong()
        BufferedInputStream(connection.inputStream).use { input ->
          FileOutputStream(dest).use { output ->
            val buffer = ByteArray(16 * 1024)
            var received = 0L
            var read: Int
            var lastEmit = 0L
            while (input.read(buffer).also { read = it } != -1) {
              output.write(buffer, 0, read)
              received += read
              // Throttle progress events to ~30/sec worth of byte deltas.
              if (received - lastEmit > 32 * 1024) {
                emitProgress(received, total)
                lastEmit = received
              }
            }
            emitProgress(received, if (total > 0) total else received)
          }
        }
        promise.resolve(destPath)
      } catch (e: Exception) {
        promise.reject("E_DOWNLOAD", e.message, e)
      } finally {
        connection?.disconnect()
      }
    }.start()
  }

  private fun emitProgress(received: Long, total: Long) {
    val map: WritableMap = Arguments.createMap().apply {
      putDouble("received", received.toDouble())
      putDouble("total", total.toDouble())
    }
    try {
      reactApplicationContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(EVENT_PROGRESS, map)
    } catch (_: Exception) {
      // Emitter not ready (e.g. during teardown) — safe to drop progress.
    }
  }

  // ─── Unzip (java.util.zip.ZipInputStream, zip-slip safe) ─────────────

  override fun unzipFile(zipPath: String, destDir: String, promise: Promise) {
    Thread {
      try {
        val outRoot = File(destDir)
        outRoot.mkdirs()
        val canonicalRoot = outRoot.canonicalPath

        ZipInputStream(BufferedInputStream(File(zipPath).inputStream())).use { zis ->
          var entry = zis.nextEntry
          val buffer = ByteArray(16 * 1024)
          while (entry != null) {
            val outFile = File(outRoot, entry.name)

            // zip-slip guard: resolved path must stay under destDir.
            if (!outFile.canonicalPath.startsWith(canonicalRoot + File.separator) &&
              outFile.canonicalPath != canonicalRoot
            ) {
              promise.reject("E_UNZIP_SLIP", "unsafe path in zip: ${entry.name}")
              return@Thread
            }

            if (entry.isDirectory) {
              outFile.mkdirs()
            } else {
              outFile.parentFile?.mkdirs()
              FileOutputStream(outFile).use { fos ->
                var read: Int
                while (zis.read(buffer).also { read = it } != -1) {
                  fos.write(buffer, 0, read)
                }
              }
            }
            zis.closeEntry()
            entry = zis.nextEntry
          }
        }
        promise.resolve(destDir)
      } catch (e: IOException) {
        promise.reject("E_UNZIP", e.message, e)
      } catch (e: Exception) {
        promise.reject("E_UNZIP", e.message, e)
      }
    }.start()
  }

  // ─── File system helpers ─────────────────────────────────────────────

  override fun fileExists(path: String, promise: Promise) {
    promise.resolve(File(path).exists())
  }

  override fun deletePath(path: String, promise: Promise) {
    try {
      val f = File(path)
      if (f.exists()) f.deleteRecursively()
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_DELETE", e.message, e)
    }
  }

  override fun movePath(srcPath: String, destPath: String, promise: Promise) {
    try {
      val src = File(srcPath)
      val dest = File(destPath)
      dest.parentFile?.mkdirs()
      if (dest.exists()) dest.deleteRecursively()
      if (!src.renameTo(dest)) {
        // renameTo can fail across mount points; fall back to copy+delete.
        src.copyRecursively(dest, overwrite = true)
        src.deleteRecursively()
      }
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("E_MOVE", e.message, e)
    }
  }

  override fun listDir(path: String, promise: Promise) {
    try {
      val children = File(path).list() ?: arrayOf()
      val arr: WritableArray = Arguments.createArray()
      children.forEach { arr.pushString(it) }
      promise.resolve(arr)
    } catch (e: Exception) {
      promise.reject("E_LISTDIR", e.message, e)
    }
  }

  override fun getDocumentsPath(): String {
    // filesDir is the app-private, backed-up equivalent of iOS Documents.
    return appContext.filesDir.absolutePath
  }

  // ─── Crash guard (Layer 1 counter mutation from JS) ──────────────────

  override fun markBundleHealthy(promise: Promise) {
    prefs().edit()
      .putInt(KEY_FAIL_COUNT, 0)
      .remove(KEY_PREVIOUS) // promote active bundle to known-good
      .apply()
    promise.resolve(null)
  }

  override fun markBundleFailed(reason: String, promise: Promise) {
    // Force to/over threshold so the next launch rolls back.
    prefs().edit().putInt(KEY_FAIL_COUNT, FAIL_THRESHOLD).apply()
    promise.resolve(null)
  }

  override fun getLaunchFailureCount(promise: Promise) {
    promise.resolve(prefs().getInt(KEY_FAIL_COUNT, 0).toDouble())
  }

  override fun isRunningBundle(): Boolean {
    val path = activeBundlePath(appContext) ?: return false
    return File(path).exists()
  }

  // ─── Restart (JS runtime reload) ─────────────────────────────────────

  override fun restart() {
    // Recreate the React context on the UI thread without killing the
    // process. On the New Architecture the ReactHost owns reloads; on the
    // bridge architecture the ReactInstanceManager does. We reflectively
    // pick whichever the host app exposes so we depend on neither directly.
    val activity = currentActivity ?: reactApplicationContext.currentActivity
    val runnable = Runnable {
      val app = appContext.applicationContext
      if (!invokeReactHostReload(app)) {
        invokeReactInstanceManagerReload(app)
      }
      // If neither reflective path succeeds, the staged bundle still applies
      // on the next natural cold start — we never crash the app trying.
    }
    if (activity != null) {
      activity.runOnUiThread(runnable)
    } else {
      android.os.Handler(android.os.Looper.getMainLooper()).post(runnable)
    }
  }

  /** Try ReactApplication -> ReactHost.reload(String). Returns true if invoked. */
  private fun invokeReactHostReload(app: Context): Boolean {
    return try {
      val reactAppClass = Class.forName("com.facebook.react.ReactApplication")
      if (!reactAppClass.isInstance(app)) return false
      val getReactHost = reactAppClass.getMethod("getReactHost")
      val reactHost = getReactHost.invoke(app) ?: return false
      val reload = reactHost.javaClass.getMethod("reload", String::class.java)
      reload.invoke(reactHost, "AeroPush update applied")
      true
    } catch (_: Throwable) {
      false
    }
  }

  /** Legacy bridge fallback: ReactInstanceManager.recreateReactContextInBackground(). */
  private fun invokeReactInstanceManagerReload(app: Context): Boolean {
    return try {
      val reactAppClass = Class.forName("com.facebook.react.ReactApplication")
      if (!reactAppClass.isInstance(app)) return false
      val getHost = reactAppClass.getMethod("getReactNativeHost")
      val host = getHost.invoke(app) ?: return false
      val getMgr = host.javaClass.getMethod("getReactInstanceManager")
      val mgr = getMgr.invoke(host) ?: return false
      @Suppress("DEPRECATION")
      val recreate = mgr.javaClass.getMethod("recreateReactContextInBackground")
      recreate.invoke(mgr)
      true
    } catch (_: Throwable) {
      false
    }
  }

  // ─── Installation id ─────────────────────────────────────────────────

  override fun getInstallationId(): String {
    val p = prefs()
    p.getString(KEY_INSTALL_ID, null)?.let { return it }
    // Random per-install UUID — never a hardware identifier, no PII.
    val fresh = java.util.UUID.randomUUID().toString()
    p.edit().putString(KEY_INSTALL_ID, fresh).apply()
    return fresh
  }

  // ─── Bundle identifier ───────────────────────────────────────────────

  override fun getBundleIdentifier(): String {
    // Android applicationId as installed on the device.
    return appContext.packageName ?: ""
  }

  // ─── Fingerprint ─────────────────────────────────────────────────────

  override fun getNativeFingerprint(): String {
    return try {
      // Read the value the host app baked into BuildConfig at build time.
      val clazz = Class.forName("${appContext.packageName}.BuildConfig")
      val field = clazz.getField("AEROPUSH_NATIVE_FINGERPRINT")
      (field.get(null) as? String) ?: ""
    } catch (_: Exception) {
      ""
    }
  }

  // ─── Event emitter plumbing (no-ops; required by spec) ───────────────

  override fun addListener(eventName: String) { /* NativeEventEmitter bookkeeping */ }

  override fun removeListeners(count: Double) { /* NativeEventEmitter bookkeeping */ }

  companion object {
    const val NAME = "Aeropush"

    private const val PREFS = "aeropush"
    private const val KEY_ACTIVE = "aeropush_active_bundle_path"
    private const val KEY_PREVIOUS = "aeropush_previous_bundle_path"
    private const val KEY_FAIL_COUNT = "aeropush_launch_failure_count"
    private const val KEY_DID_BACKGROUND = "aeropush_did_background"
    private const val KEY_INSTALL_ID = "aeropush_installation_id"
    private const val FAIL_THRESHOLD = 3

    private const val EVENT_PROGRESS = "AeropushDownloadProgress"

    // ── Launcher API (native-to-native, no JS runtime required) ────────

    /**
     * Raw active bundle path, or null. Used by [getJSBundleFile] hook.
     */
    @JvmStatic
    fun activeBundlePath(context: Context): String? {
      val p = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val path = p.getString(KEY_ACTIVE, null)
      return if (path.isNullOrEmpty()) null else path
    }

    /**
     * The JS bundle file the app should boot from, running the Layer-1
     * launch-counter check + rollback first. Call this from
     * MainApplication's ReactNativeHost.getJSBundleFile(). Returns null to
     * fall back to the embedded "assets://index.android.bundle".
     */
    @JvmStatic
    fun getJSBundleFile(context: Context): String? {
      val p = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)

      val failures = p.getInt(KEY_FAIL_COUNT, 0)
      if (failures >= FAIL_THRESHOLD) {
        // Roll back before handing a path to the runtime.
        rollbackToPrevious(context)
        p.edit().putInt(KEY_FAIL_COUNT, 0).apply()
      } else {
        // Count this launch as in-progress; JS clears via markBundleHealthy.
        p.edit()
          .putInt(KEY_FAIL_COUNT, failures + 1)
          .putBoolean(KEY_DID_BACKGROUND, false)
          .apply()
      }

      val path = activeBundlePath(context) ?: return null
      val file = File(path)
      return if (file.exists()) path else null
    }

    @JvmStatic
    private fun rollbackToPrevious(context: Context) {
      val p = context.applicationContext
        .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val previous = p.getString(KEY_PREVIOUS, null)
      val editor = p.edit()
      if (!previous.isNullOrEmpty() && File(previous).exists()) {
        editor.putString(KEY_ACTIVE, previous)
      } else {
        editor.remove(KEY_ACTIVE)
      }
      editor.remove(KEY_PREVIOUS).apply()
    }
  }
}
