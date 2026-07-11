package com.aeropushexample

import android.app.Application
import com.aeropush.AeropushModule
import com.aeropush.AeropushPackage
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

/**
 * Shows the TWO integration points AeroPush needs on Android:
 *   1. Register AeropushPackage() so the TurboModule is available to JS.
 *   2. Override getJSBundleFile() so the app boots from the active OTA bundle
 *      (with the Layer-1 launch-counter check) when one is staged.
 */
class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
    object : DefaultReactNativeHost(this) {

      override fun getPackages(): List<ReactPackage> =
        PackageList(this).packages.apply {
          // Autolinking picks this up automatically in a real project; shown
          // explicitly here so the wiring is obvious in the example.
          add(AeropushPackage())
        }

      override fun getJSMainModuleName(): String = "index"

      override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

      override val isNewArchEnabled: Boolean = true
      override val isHermesEnabled: Boolean = true

      // ── The AeroPush bundle hook ──────────────────────────────────────
      override fun getJSBundleFile(): String? {
        // In debug, return null so Metro serves the bundle (Fast Refresh).
        if (BuildConfig.DEBUG) return null
        // In release, prefer the staged OTA bundle. Returning null falls back
        // to the embedded assets://index.android.bundle.
        return AeropushModule.getJSBundleFile(applicationContext)
      }
    }

  override val reactHost: ReactHost
    get() = com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, OpenSourceMergedSoMapping)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      load()
    }
  }
}
