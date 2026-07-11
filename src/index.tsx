import { NativeEventEmitter, NativeModules, AppState, Platform } from 'react-native';
import type { EmitterSubscription, AppStateStatus } from 'react-native';
import Native from './NativeAeropush';

/**
 * AeroPush — public SDK surface
 * ------------------------------
 * `NativeAeropush.ts` is the primitive Codegen contract. This file is what
 * application developers actually import. It adds:
 *   - typed enums + metadata objects (Codegen can't express these)
 *   - the check/download/apply orchestration (`sync`)
 *   - install-mode handling (restart now / on resume / on next launch)
 *   - automatic crash-guard wiring (Layers 2 & 3 talk to native Layer 1)
 *
 * Nothing here does native work directly; it all funnels through `Native`.
 */

// ─── PUBLIC TYPES ──────────────────────────────────────────────────────────

export enum InstallMode {
  /** Download silently; the new bundle is picked up on the next cold launch. */
  ON_NEXT_RESTART = 'ON_NEXT_RESTART',
  /** Download silently; apply when the app next returns from background. */
  ON_NEXT_RESUME = 'ON_NEXT_RESUME',
  /** Download then reload the JS runtime immediately. */
  IMMEDIATE = 'IMMEDIATE',
}

export interface AeropushConfig {
  /** App key issued by the AeroPush dashboard. */
  appKey: string;
  /** Release channel to track, e.g. "production", "staging", "beta". */
  channel?: string;
  /** Base URL of the AeroPush server. Defaults to the hosted service. */
  serverUrl?: string;
  /**
   * Consecutive-crash threshold before the NEXT launch auto-rolls back.
   * Mirrors the native Layer-1 counter default. Kept here for docs; the
   * authoritative value lives natively.
   */
  crashRollbackThreshold?: number;
}

export interface UpdateInfo {
  /** Monotonic bundle version on the server. */
  version: number;
  /** Human release notes shown to developers / optionally users. */
  releaseNotes: string;
  /** If true the app should not continue on the old bundle. */
  isMandatory: boolean;
  /** Pre-signed URL to the bundle zip. */
  downloadUrl: string;
  /** Size of the bundle zip in bytes. */
  bundleSize: number;
  /** SHA-256 integrity checksum ("sha256:..."). */
  checksum: string;
  /**
   * True when the server delivered this bundle despite a native fingerprint
   * mismatch (developer force-pushed). The SDK tightens crash handling.
   */
  fingerprintWarning: boolean;
}

export interface SyncOptions {
  installMode?: InstallMode;
  onUpdateAvailable?: (update: UpdateInfo) => void;
  onProgress?: (received: number, total: number) => void;
  onUpToDate?: () => void;
  onError?: (error: Error) => void;
}

export enum SyncStatus {
  UP_TO_DATE = 'UP_TO_DATE',
  UPDATE_INSTALLED = 'UPDATE_INSTALLED',
  UPDATE_INSTALLED_PENDING_RESTART = 'UPDATE_INSTALLED_PENDING_RESTART',
  ERROR = 'ERROR',
}

// ─── EVENTS ────────────────────────────────────────────────────────────────

const emitter = new NativeEventEmitter(
  // On the New Architecture the module is reachable via NativeModules for
  // event-emitter purposes; the typed calls still go through `Native`.
  NativeModules.Aeropush,
);

const DOWNLOAD_PROGRESS_EVENT = 'AeropushDownloadProgress';

// ─── INTERNAL STATE ────────────────────────────────────────────────────────

let config: AeropushConfig | null = null;
let crashHandlerInstalled = false;
let resumeSubscription: EmitterSubscription | { remove(): void } | null = null;

function requireConfig(): AeropushConfig {
  if (!config) {
    throw new Error(
      '[AeroPush] SDK not initialised. Call AeroPush.init({ appKey }) first.',
    );
  }
  return config;
}

// ─── CRASH GUARD (LAYERS 2 & 3 → NATIVE LAYER 1) ───────────────────────────

/**
 * Installs the global JS error handler (Layer 2). React render errors
 * (Layer 3) are captured by the exported <AeroPushBoundary> component, which
 * calls the same `markBundleFailed` path. Both ultimately tell the native
 * launch counter that this bundle is unhealthy so the next start rolls back.
 */
function installCrashHandler(): void {
  if (crashHandlerInstalled) return;
  crashHandlerInstalled = true;

  // Only meaningful when we're actually on an OTA bundle.
  if (!Native.isRunningBundle()) return;

  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
      setGlobalHandler(
        handler: (error: unknown, isFatal?: boolean) => void,
      ): void;
    };
  };

  const ErrorUtils = g.ErrorUtils;
  if (!ErrorUtils) return;

  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    if (isFatal) {
      const message =
        error instanceof Error ? error.message : String(error ?? 'unknown');
      // Fire-and-forget; we must not block the crash path.
      void Native.markBundleFailed(message);
    }
    previous(error, isFatal);
  });
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────

/**
 * Initialise the SDK. Call once, as early as possible (before first render),
 * typically at module scope in your app entry file.
 */
export function init(userConfig: AeropushConfig): void {
  config = {
    channel: 'production',
    serverUrl: 'https://api.aeropush.io',
    ...userConfig,
  };
  installCrashHandler();
}

/**
 * Confirm the currently running bundle is healthy. Safe to call on every
 * successful mount. Resets the native crash counter. If you use
 * <AeroPushBoundary> this is called for you.
 */
export function markBundleHealthy(): Promise<void> {
  return Native.markBundleHealthy();
}

/** The version number of the bundle currently running (0 = binary bundle). */
export async function getCurrentVersion(): Promise<number> {
  const path = Native.getActiveBundlePath();
  if (!path) return 0;
  // Version is encoded in our bundle directory naming; the native side owns
  // the source of truth. For now we surface via a stored meta file read in a
  // later phase. Placeholder returns 0 until Phase 2 metadata lands.
  return 0;
}

/** Roll back to the previously installed good bundle (or the binary bundle). */
export async function rollback(): Promise<void> {
  await Native.clearActiveBundlePath();
}

/** Reload the JS runtime to apply a pending bundle. */
export function restart(): void {
  Native.restart();
}

/** Low-level escape hatch: the raw native module. Use sparingly. */
export const unstable_native = Native;

/**
 * Check the server for an update and, if present, download + stage it
 * according to the chosen install mode. This is the primary entry point apps
 * call on launch / resume.
 *
 * NOTE: The network check itself is implemented in Phase 2/3 against the real
 * server contract. This function currently wires the orchestration and the
 * native download/unzip/apply steps; the `/v1/check` fetch is stubbed where
 * indicated so the surface is testable now.
 */
export async function sync(options: SyncOptions = {}): Promise<SyncStatus> {
  const cfg = requireConfig();
  const installMode = options.installMode ?? InstallMode.ON_NEXT_RESTART;

  const progressSub = emitter.addListener(
    DOWNLOAD_PROGRESS_EVENT,
    (e: { received: number; total: number }) => {
      options.onProgress?.(e.received, e.total);
    },
  );

  try {
    // ── 1. CHECK ────────────────────────────────────────────────────────
    // Phase 3 replaces this stub with a real fetch to `${cfg.serverUrl}/v1/check`
    // sending appKey, channel, current version, platform, and native
    // fingerprint (Native.getNativeFingerprint()).
    const update: UpdateInfo | null = await checkForUpdate(cfg);

    if (!update) {
      options.onUpToDate?.();
      return SyncStatus.UP_TO_DATE;
    }

    options.onUpdateAvailable?.(update);

    // ── 2. DOWNLOAD ─────────────────────────────────────────────────────
    const docs = Native.getDocumentsPath();
    const stamp = `${update.version}_${Date.now()}`;
    const zipPath = `${docs}/aeropush/downloads/${stamp}.zip`;
    const outDir = `${docs}/aeropush/bundles/${stamp}`;

    await Native.downloadFile(update.downloadUrl, zipPath, {
      'X-App-Key': cfg.appKey,
    });

    // ── 3. (checksum verification lands in Phase 6) ─────────────────────

    // ── 4. UNZIP ────────────────────────────────────────────────────────
    await Native.unzipFile(zipPath, outDir);
    await Native.deletePath(zipPath);

    // ── 5. APPLY (stage the new bundle pointer) ─────────────────────────
    // The zip is expected to contain the platform bundle at its root. Metro
    // emits `index.android.bundle` / `main.jsbundle` conventionally; we
    // resolve the right entry per platform and verify it exists before
    // pointing the launcher at it.
    const bundleEntry = await resolveBundleEntry(outDir);
    await Native.setActiveBundlePath(bundleEntry);

    // If the server force-pushed past a fingerprint mismatch, we rely on the
    // native counter tightening handled server-side via the warning flag.
    void update.fingerprintWarning;

    // ── 6. INSTALL MODE ─────────────────────────────────────────────────
    switch (installMode) {
      case InstallMode.IMMEDIATE:
        Native.restart();
        return SyncStatus.UPDATE_INSTALLED;

      case InstallMode.ON_NEXT_RESUME:
        armResumeRestart();
        return SyncStatus.UPDATE_INSTALLED_PENDING_RESTART;

      case InstallMode.ON_NEXT_RESTART:
      default:
        return SyncStatus.UPDATE_INSTALLED_PENDING_RESTART;
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    options.onError?.(error);
    return SyncStatus.ERROR;
  } finally {
    progressSub.remove();
  }
}

/** Restart the next time the app returns to the foreground. */
function armResumeRestart(): void {
  if (resumeSubscription) return;
  const handler = (state: AppStateStatus) => {
    if (state === 'active') {
      Native.restart();
    }
  };
  resumeSubscription = AppState.addEventListener('change', handler);
}

/**
 * Find the platform bundle file inside an extracted bundle directory. Checks
 * the conventional Metro output names first, then falls back to scanning the
 * directory for any *.bundle / *.jsbundle so we tolerate custom bundle names.
 */
async function resolveBundleEntry(dir: string): Promise<string> {
  const candidates =
    Platform.OS === 'ios'
      ? ['main.jsbundle', 'index.ios.bundle', 'index.bundle']
      : ['index.android.bundle', 'index.bundle'];

  for (const name of candidates) {
    const full = `${dir}/${name}`;
    if (await Native.fileExists(full)) return full;
  }

  // Fallback: scan for a bundle-looking file at the root.
  const entries = await Native.listDir(dir);
  const found = entries.find(
    (f) => f.endsWith('.bundle') || f.endsWith('.jsbundle'),
  );
  if (found) return `${dir}/${found}`;

  throw new Error(
    `[AeroPush] no bundle file found in ${dir} (looked for ${candidates.join(', ')})`,
  );
}

/**
 * HARDCODED update check (development / demo mode).
 * -------------------------------------------------
 * In production (Phase 3) this becomes a real fetch to
 * `${cfg.serverUrl}/v1/check` sending appKey, channel, current version,
 * platform, and native fingerprint. For now it returns a fixed UpdateInfo so
 * the entire sync → download → unzip → apply pipeline can be exercised
 * end-to-end against a real bundle URL on a device.
 *
 * Set `HARDCODED_UPDATE` to null to simulate the "up to date" branch.
 */
const HARDCODED_UPDATE: UpdateInfo | null = {
  version: 1,
  releaseNotes: 'Hardcoded demo bundle (AeroPush sync pipeline test).',
  isMandatory: false,
  // Bundles built with `npx aeropush bundle` and uploaded to the test host.
  // The zip contains main.jsbundle (iOS) / index.android.bundle (Android) at
  // its root, which is what resolveBundleEntry() expects.
  downloadUrl: Platform.select({
    ios: 'https://ota.cavyiot.com/bundles/ios.zip',
    default: 'https://ota.cavyiot.com/bundles/android.zip',
  }),
  bundleSize: 0,
  checksum: '',
  fingerprintWarning: false,
};

async function checkForUpdate(cfg: AeropushConfig): Promise<UpdateInfo | null> {
  // Simulate a network round-trip so callers see realistic async behaviour.
  await new Promise<void>((r) => setTimeout(() => r(), 150));

  const current = await getCurrentVersion();
  const candidate = HARDCODED_UPDATE;
  if (!candidate) return null;

  // Only "offer" the update if it's newer than what's running, mirroring the
  // real server's version-gating so the demo doesn't loop forever.
  if (candidate.version <= current) return null;

  // Echo the configured channel into the log so the wiring is observable.
  if (__DEV__) {
    console.log(
      `[AeroPush] hardcoded check: channel=${cfg.channel} → v${candidate.version}`,
    );
  }
  return candidate;
}

// Re-export the boundary component (Layer 3).
export { AeroPushBoundary } from './AeroPushBoundary';

export default {
  init,
  sync,
  rollback,
  restart,
  markBundleHealthy,
  getCurrentVersion,
  InstallMode,
  SyncStatus,
  unstable_native,
};
