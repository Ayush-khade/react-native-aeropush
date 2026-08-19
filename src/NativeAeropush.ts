import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * AeroPush Turbo Module Spec
 * ---------------------------
 * This is the Codegen contract. React Native's Codegen reads THIS file at
 * build time and generates the native C++/Obj-C++/Java interfaces that both
 * the Swift/Kotlin implementations and the JS side conform to.
 *
 * RULES enforced by Codegen (do not break these):
 *  - File MUST be named with the `Native` prefix (NativeAeropush.ts).
 *  - Only a limited set of types are allowed across the bridge:
 *      boolean, number, string, void, Object, Array, Promise, and
 *      readonly arrays/objects of those. No enums, no union types, no
 *      optional-with-default. Optionals are expressed as `?`.
 *  - Methods returning a value asynchronously MUST return a Promise.
 *  - Methods that must run synchronously (blocking JS) return the value
 *    directly. We keep these to an absolute minimum.
 *
 * Everything in the richer public API (install modes, typed callbacks,
 * update metadata objects) is layered on top of this raw spec inside
 * src/index.tsx. This file stays deliberately primitive so Codegen is happy.
 */

export interface Spec extends TurboModule {
  // ─── BUNDLE PATH RESOLUTION ────────────────────────────────────────────
  // These are the heart of the module. The native AppDelegate /
  // MainApplication hook calls the native side of these directly (native to
  // native) before JS boots. They are also exposed to JS for inspection.

  /**
   * Returns the absolute file path of the currently active JS bundle, or
   * empty string if none has been set (meaning: fall back to the binary's
   * built-in bundle). Synchronous because the native launcher needs it
   * before the JS runtime exists.
   */
  getActiveBundlePath(): string;

  /**
   * Persist the path that should be loaded on the NEXT app start.
   * Does not affect the currently running JS. Returns a Promise that
   * resolves once the write to NSUserDefaults / SharedPreferences is done.
   */
  setActiveBundlePath(path: string): Promise<void>;

  /**
   * Clear the active bundle pointer entirely. Next launch falls back to the
   * binary's embedded bundle. Used by rollback-to-binary.
   */
  clearActiveBundlePath(): Promise<void>;

  // ─── FILE DOWNLOAD ─────────────────────────────────────────────────────

  /**
   * Download a file from `url` to `destPath`. Optional headers are passed
   * as a flat string->string object (e.g. auth token). Progress is emitted
   * via the module's event emitter under "AeropushDownloadProgress".
   * Resolves with the final on-disk path on success.
   */
  downloadFile(
    url: string,
    destPath: string,
    headers: Object,
  ): Promise<string>;

  // ─── UNZIP ─────────────────────────────────────────────────────────────

  /**
   * Unzip `zipPath` into `destDir`, creating destDir if needed. Resolves
   * with destDir on success. Rejects on any malformed / unsafe entry
   * (zip-slip protection is enforced natively).
   */
  unzipFile(zipPath: string, destDir: string): Promise<string>;

  // ─── FILE SYSTEM HELPERS ───────────────────────────────────────────────

  /** Returns true if a file or directory exists at `path`. */
  fileExists(path: string): Promise<boolean>;

  /** Delete a file or directory (recursive) at `path`. No-op if absent. */
  deletePath(path: string): Promise<void>;

  /** Move/rename `srcPath` to `destPath`. */
  movePath(srcPath: string, destPath: string): Promise<void>;

  /** List immediate children (names only) of a directory. */
  listDir(path: string): Promise<string[]>;

  /**
   * Absolute path to the app's private documents directory where we store
   * downloaded bundles. Synchronous — it's a constant lookup and callers
   * frequently need it to build paths before any async work.
   */
  getDocumentsPath(): string;

  // ─── CRASH GUARD (LAYER 1: NATIVE LAUNCH COUNTER) ──────────────────────

  /**
   * Called by JS as soon as the app has mounted successfully. Resets the
   * native launch-failure counter to 0, marking the current bundle healthy.
   */
  markBundleHealthy(): Promise<void>;

  /**
   * Called by JS error handlers (Layer 2 / Layer 3) when a fatal error is
   * caught. Writes a crash flag so the native launcher rolls back on next
   * start. `reason` is stored for later reporting to the server.
   */
  markBundleFailed(reason: string): Promise<void>;

  /**
   * Returns the current consecutive-launch-failure count. Exposed mostly
   * for diagnostics / tests.
   */
  getLaunchFailureCount(): Promise<number>;

  /**
   * Whether the app is currently running an OTA bundle (true) versus the
   * binary's embedded bundle (false). JS uses this to decide whether crash
   * handling should trigger a rollback.
   */
  isRunningBundle(): boolean;

  // ─── RESTART ───────────────────────────────────────────────────────────

  /**
   * Reload the JS runtime so a newly-applied bundle takes effect, WITHOUT
   * killing the native process. iOS: RCTReloadCommand. Android:
   * recreateReactContextInBackground(). Returns void; JS execution after
   * this call is not guaranteed to continue.
   */
  restart(): void;

  // ─── FINGERPRINT ───────────────────────────────────────────────────────

  /**
   * Returns the native fingerprint that was baked into the binary at build
   * time (from Info.plist on iOS / BuildConfig on Android). Empty string if
   * the host app never embedded one. Sent to the server on update checks so
   * the server can refuse bundles compiled against incompatible native code.
   */
  getNativeFingerprint(): string;

  // ─── INSTALLATION ID ───────────────────────────────────────────────────

  /**
   * A random UUID generated once per install and persisted natively
   * (NSUserDefaults / SharedPreferences). Sent — hashed server-side — as the
   * anonymous device identifier in /v1/event pings. Never derived from any
   * hardware identifier; carries no PII.
   */
  getInstallationId(): string;

  // ─── BUNDLE IDENTIFIER ─────────────────────────────────────────────────

  /**
   * The app's native bundle identifier read straight from the binary:
   * iOS `Bundle.main.bundleIdentifier`, Android `packageName`. Sent as
   * `X-Bundle-Id` on update checks so the server can enforce that an app key
   * is only ever used by its own app (§13 scoping). Empty string if unavailable.
   */
  getBundleIdentifier(): string;

  // ─── EVENT EMITTER PLUMBING (required by Codegen for events) ───────────

  /** Subscribe hook required by the TurboModule event system. */
  addListener(eventName: string): void;

  /** Unsubscribe hook required by the TurboModule event system. */
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Aeropush');
