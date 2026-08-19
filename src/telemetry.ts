import { Platform } from 'react-native';
import Native from './NativeAeropush';

/**
 * telemetry.ts — the SDK's server-communication side channel.
 * ------------------------------------------------------------
 * Owns the wire config (set once by `init()`) and the fire-and-forget
 * `POST /v1/event` pings that power the dashboard's adoption counts and,
 * later, crash intelligence. Lives in its own module so both `index.tsx`
 * and `AeroPushBoundary.tsx` can report events without an import cycle.
 *
 * INVARIANT: nothing in this file may ever throw into the caller. Telemetry
 * failing must never break an app — especially not on the crash path.
 */

interface ServerConfig {
  appKey: string;
  channel: string;
  /** The raw base the developer configured (origin, or …/v1, or …/v1/api). */
  serverUrl: string;
  /** Normalised REST base — always the `…/v1/api` form the backend serves. */
  apiUrl: string;
}

let serverConfig: ServerConfig | null = null;

/**
 * Resolve the REST API base from whatever the developer passed as `serverUrl`.
 * The AeroPush backend serves its endpoints under `…/v1/api` (with `…/v1/*`
 * aliases). To be forgiving, we accept the origin (`https://host`), the
 * versioned root (`…/v1`) or the full base (`…/v1/api`) and always return the
 * `…/v1/api` form, so the SDK, CLI and dashboard all agree on one URL shape.
 */
export function resolveApiBase(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  if (/\/v1\/api$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/api`;
  return `${trimmed}/v1/api`;
}

/** Called by `init()`. Trailing slashes are normalised away once, here. */
export function configureTelemetry(cfg: {
  appKey: string;
  channel: string;
  serverUrl: string;
}): void {
  const serverUrl = cfg.serverUrl.replace(/\/+$/, '');
  serverConfig = { ...cfg, serverUrl, apiUrl: resolveApiBase(serverUrl) };
}

export function getServerConfig(): ServerConfig | null {
  return serverConfig;
}

/**
 * The OTA bundle version currently pointed at by the native launcher
 * (0 = binary bundle). Bundles are staged at
 * `.../aeropush/bundles/<version>_<timestamp>/<entry>`, so the version is
 * recoverable from the active path itself — no extra metadata file needed.
 */
export function currentBundleVersion(): number {
  try {
    const path = Native.getActiveBundlePath();
    if (!path) return 0;
    const m = path.match(/[/\\]aeropush[/\\]bundles[/\\](\d+)_\d+[/\\]/);
    return m ? parseInt(m[1], 10) : 0;
  } catch {
    return 0;
  }
}

export type AeropushEventType =
  | 'UPDATE_APPLIED'
  | 'UPDATE_FAILED'
  | 'ROLLBACK_TRIGGERED'
  | 'CRASH_DETECTED'
  | 'LAUNCH_COUNTER_ROLLBACK'
  | 'FORCE_PUSH_CRASH';

export interface EventDetails {
  fromVersion?: number;
  toVersion?: number;
  errorMessage?: string;
  crashLayer?:
    | 'EARLY_JS_ERROR'
    | 'GLOBAL_HANDLER'
    | 'ERROR_BOUNDARY'
    | 'LAUNCH_COUNTER';
}

/**
 * Fire-and-forget event ping. Silently a no-op until `init()` has run, and
 * silently swallows every network/serialisation failure.
 */
export function reportEvent(event: AeropushEventType, details: EventDetails = {}): void {
  const cfg = serverConfig;
  if (!cfg) return;
  try {
    const body = JSON.stringify({
      event,
      // Random per-install UUID (hashed again server-side). Never PII.
      deviceId: Native.getInstallationId(),
      platform: Platform.OS,
      channel: cfg.channel,
      timestamp: new Date().toISOString(),
      ...details,
    });
    void fetch(`${cfg.apiUrl}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': cfg.appKey,
      },
      body,
    }).catch(() => {
      /* offline / server down — drop the ping */
    });
  } catch {
    /* telemetry must never break the app */
  }
}
