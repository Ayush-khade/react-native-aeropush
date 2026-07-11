# react-native-aeropush

Zero-dependency **Over-The-Air (OTA) update SDK** for React Native, built as a
New Architecture **Turbo Module**. Ship JavaScript bundle updates to production
apps without an App Store / Play Store release — with a native crash-guard that
**auto-rolls back a bad bundle** and a **fingerprint check** that refuses
bundles compiled against incompatible native code.

> Status: early development (v0.1). The client SDK + native layer are
> implemented. The hosted server, dashboard, and CLI are on the roadmap (see
> `OTA.md`). The update check is currently **hardcoded** for local testing.

## Why another OTA library?

- **Zero third-party native dependencies.** No `react-native-fs`, no
  `react-native-blob-util`. Downloading (`NSURLSession` / `HttpURLConnection`),
  unzipping (zlib + ZIP parsing / `ZipInputStream`), storage
  (`NSUserDefaults` / `SharedPreferences`) are all first-party platform APIs.
- **New Architecture native.** Proper Codegen Turbo Module, not a bridge shim.
- **Crash-safe by design.** A three-layer crash guard (native launch counter +
  JS global handler + React error boundary) rolls back automatically.
- **Native compatibility fingerprint.** Prevents the classic "added a native
  module, pushed JS-only, app crashes on old binaries" failure.

## Requirements

- React Native **0.76+** (New Architecture enabled)
- iOS 13.4+
- Android minSdk 24+

## Install

```sh
npm install react-native-aeropush
# iOS
cd ios && pod install
```

## Quick start

```tsx
import AeroPush, { AeroPushBoundary, InstallMode } from 'react-native-aeropush';

// 1. Initialise once, before your app renders.
AeroPush.init({ appKey: 'YOUR_APP_KEY', channel: 'production' });

// 2. Check for and stage updates (e.g. on launch).
await AeroPush.sync({ installMode: InstallMode.ON_NEXT_RESTART });

// 3. Wrap your app so render crashes trigger auto-rollback.
export default function App() {
  return (
    <AeroPushBoundary>
      <YourApp />
    </AeroPushBoundary>
  );
}
```

## Native integration (one hook per platform)

The SDK needs a single hook so the app boots from the staged bundle. In debug
builds it always defers to Metro.

### iOS — `AppDelegate.swift`

Add a bridging header (`#import "Aeropush.h"`) and override the bundle URL:

```swift
override func bundleURL() -> URL? {
  #if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
  #else
    return Aeropush.bundleURL()
      ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
  #endif
}
```

### Android — `MainApplication.kt`

```kotlin
override fun getJSBundleFile(): String? {
  if (BuildConfig.DEBUG) return null            // Metro serves it
  return AeropushModule.getJSBundleFile(applicationContext)
}
```

`Aeropush.bundleURL()` / `AeropushModule.getJSBundleFile()` run the launch-
counter check and return the OTA bundle, or fall back to the embedded binary
bundle (including after an auto-rollback).

## Install modes

| Mode | Behaviour |
|---|---|
| `ON_NEXT_RESTART` (default) | Download silently; apply on next cold launch. |
| `ON_NEXT_RESUME` | Download silently; apply when app next foregrounds. |
| `IMMEDIATE` | Download then reload the JS runtime right away. |

## How the crash guard works

1. **Native launch counter (Layer 1).** Every launch increments a counter
   before the bundle loads. `markBundleHealthy()` (called for you by
   `AeroPushBoundary` on successful mount) resets it. After 3 consecutive
   launches without a reset, the native launcher rolls back before handing a
   bundle to the runtime — this catches even native crashes that happen before
   JS runs.
2. **Global JS handler (Layer 2).** Fatal JS errors mark the bundle failed.
3. **React error boundary (Layer 3).** Render errors do the same via
   `AeroPushBoundary`.

## API

```ts
AeroPush.init(config: AeropushConfig): void
AeroPush.sync(options?: SyncOptions): Promise<SyncStatus>
AeroPush.getCurrentVersion(): Promise<number>
AeroPush.markBundleHealthy(): Promise<void>
AeroPush.rollback(): Promise<void>
AeroPush.restart(): void
```

## Running the example

The `example/` app exercises the full pipeline with an on-screen activity log.

```sh
cd example
npm install
npm run pods        # iOS only
npm run start       # Metro
npm run ios         # or: npm run android
```

The example uses a **hardcoded update** inside the SDK
(`HARDCODED_UPDATE` in `src/index.tsx`), so it runs without any backend. Point
`downloadUrl` at a reachable zip containing an `index.<platform>.bundle` to see
a real download → unzip → stage → restart cycle. (Locally: build one with
`npm run bundle:android`, zip it, and serve with `python3 -m http.server`.)

## License

MIT
