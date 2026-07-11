# Installing `react-native-aeropush` in a React Native project

Step-by-step integration guide for any bare React Native app. Verified against
RN **0.79** (example app) and RN **0.86** (OtaTest) — both AppDelegate /
MainApplication template generations are covered below.

> **Requirements:** React Native 0.76+ with the New Architecture enabled,
> iOS 13.4+, Android minSdk 24+.
>
> **Remember:** OTA only activates in **release** builds. Debug builds always
> load from Metro, so the hooks below are written to defer to Metro in debug.

---

## 1. Install the package

### From npm (once published)

```sh
npm install react-native-aeropush
```

### From a local checkout (current dev workflow)

While the package is unpublished, install it from a sibling folder. Use
`--ignore-scripts` — the SDK's `prepare` script runs `builder-bob`, which is a
devDependency you don't need (Metro consumes the TypeScript source directly
via the package's `react-native` entry point):

```sh
npm install --ignore-scripts ../react-native-aeropush
```

This creates a symlink in `node_modules`, so Metro and TypeScript need to be
told about the out-of-tree source:

**`metro.config.js`**

```js
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const aeropushRoot = path.resolve(__dirname, '..', 'react-native-aeropush');

const config = {
  watchFolders: [aeropushRoot],
  resolver: {
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
```

**`tsconfig.json`**

```jsonc
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "react-native-aeropush": ["../react-native-aeropush/src/index.tsx"],
      "react": ["./node_modules/@types/react"],
      "react-native": ["./node_modules/react-native"]
    }
  }
}
```

(Skip this whole subsection once installing from npm — a regular install needs
no Metro or tsconfig changes.)

---

## 2. iOS setup

### 2.1 Pods

```sh
cd ios && bundle exec pod install
```

Autolinking picks up the podspec and React Native Codegen generates
`AeropushSpec` automatically. No manual linking.

### 2.2 Bridging header

The AppDelegate hook calls the SDK's Obj-C++ launcher API from Swift, so the
app target needs a bridging header.

Create `ios/<AppName>/<AppName>-Bridging-Header.h`:

```objc
#import "Aeropush.h"
```

Then point the build setting at it — either in Xcode (target → Build Settings
→ **Objective-C Bridging Header**) or directly in
`ios/<AppName>.xcodeproj/project.pbxproj`, adding to **both** the Debug and
Release configurations of the app target:

```
SWIFT_OBJC_BRIDGING_HEADER = "<AppName>/<AppName>-Bridging-Header.h";
```

> If your app already has a bridging header, just add the `#import` line to it.

### 2.3 The bundle hook

Override `bundleURL()` so release builds boot from the staged OTA bundle.
`Aeropush.bundleURL()` runs the Layer-1 launch-counter check (auto-rollback)
synchronously and returns `nil` when no OTA bundle is active.

**RN 0.77+ template** (`RCTReactNativeFactory` — the `ReactNativeDelegate`
class inside `AppDelegate.swift`):

```swift
class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    // Prefer the active OTA bundle; fall back to the embedded binary bundle.
    Aeropush.bundleURL()
      ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
```

**RN 0.76 template** (`RCTAppDelegate` subclass): identical override, placed
directly on your `AppDelegate`:

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

---

## 3. Android setup

Autolinking registers the Turbo Module; the only manual step is the bundle
hook in `MainApplication.kt`. `AeropushModule.getJSBundleFile(context)` runs
the launch-counter check and returns `null` when no OTA bundle is active
(falling back to the embedded `assets://index.android.bundle`).

**RN 0.8x template** (`getDefaultReactHost`):

```kotlin
import com.aeropush.AeropushModule

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList = PackageList(this).packages,
      // AeroPush OTA hook: boot from the staged OTA bundle when one is active.
      jsBundleFilePath =
        if (BuildConfig.DEBUG) null
        else AeropushModule.getJSBundleFile(applicationContext),
    )
  }
  // ...
}
```

**Older template** (`DefaultReactNativeHost`):

```kotlin
override fun getJSBundleFile(): String? {
  if (BuildConfig.DEBUG) return null // Metro serves the bundle
  return AeropushModule.getJSBundleFile(applicationContext)
}
```

---

## 4. JavaScript setup

Initialise once at module scope (before first render), sync on launch, and
wrap the app in the crash boundary:

```tsx
import AeroPush, { AeroPushBoundary, InstallMode } from 'react-native-aeropush';

// 1. Initialise before the component tree renders.
AeroPush.init({ appKey: 'YOUR_APP_KEY', channel: 'production' });

// 2. Check for + stage updates (e.g. on launch).
AeroPush.sync({ installMode: InstallMode.ON_NEXT_RESTART });

// 3. Layer-3 crash guard: render crashes mark the bundle failed, and a
//    successful mount marks it healthy (resets the native launch counter).
export default function App() {
  return (
    <AeroPushBoundary>
      <YourApp />
    </AeroPushBoundary>
  );
}
```

If you don't use `AeroPushBoundary`, call `AeroPush.markBundleHealthy()`
yourself after a successful mount — otherwise the native launch counter will
roll a healthy bundle back after 3 launches.

---

## 5. Jest

The Turbo Module doesn't exist off-device, so mock the SDK in tests. Add a
setup file and register it:

**`jest.config.js`**

```js
module.exports = {
  preset: 'react-native', // or '@react-native/jest-preset'
  setupFiles: ['<rootDir>/jest.setup.js'],
};
```

**`jest.setup.js`**

```js
jest.mock(
  'react-native-aeropush',
  () => {
    const InstallMode = {
      ON_NEXT_RESTART: 'ON_NEXT_RESTART',
      ON_NEXT_RESUME: 'ON_NEXT_RESUME',
      IMMEDIATE: 'IMMEDIATE',
    };
    const SyncStatus = {
      UP_TO_DATE: 'UP_TO_DATE',
      UPDATE_INSTALLED: 'UPDATE_INSTALLED',
      UPDATE_INSTALLED_PENDING_RESTART: 'UPDATE_INSTALLED_PENDING_RESTART',
      ERROR: 'ERROR',
    };
    return {
      __esModule: true,
      default: {
        init: jest.fn(),
        sync: jest.fn(() => Promise.resolve(SyncStatus.UP_TO_DATE)),
        rollback: jest.fn(() => Promise.resolve()),
        restart: jest.fn(),
        markBundleHealthy: jest.fn(() => Promise.resolve()),
        getCurrentVersion: jest.fn(() => Promise.resolve(0)),
        InstallMode,
        SyncStatus,
        unstable_native: {
          isRunningBundle: jest.fn(() => false),
          getNativeFingerprint: jest.fn(() => 'test-fingerprint'),
          markBundleFailed: jest.fn(() => Promise.resolve()),
          getLaunchFailureCount: jest.fn(() => Promise.resolve(0)),
        },
      },
      InstallMode,
      SyncStatus,
      AeroPushBoundary: ({ children }) => children,
    };
  },
  { virtual: true }, // needed for local file: installs whose `main` is unbuilt
);
```

---

## 6. Verify the integration

```sh
npx tsc --noEmit                     # types resolve
npx jest                             # tests pass with the mock
npx react-native bundle --platform ios --dev false \
  --entry-file index.js --bundle-output /tmp/main.jsbundle   # Metro resolves the SDK
```

Then build both platforms (`run-ios` / `run-android`). On first launch the
app should log `Booted. version=0 ota=false` and
`markBundleHealthy() → crash counter reset` if you use the demo screen from
the SDK's `example/`.

### Testing the full OTA pipeline (no backend yet)

The update check is currently **hardcoded** (`HARDCODED_UPDATE` in the SDK's
`src/index.tsx`) and points at the test bundle host. To exercise a real
download → unzip → stage → restart cycle:

1. Build upload-ready bundle zips for both platforms in one command,
   from your app root:
   ```sh
   npx aeropush bundle
   # → aeropush-dist/ios.zip      (main.jsbundle at zip root)
   # → aeropush-dist/android.zip  (index.android.bundle at zip root)
   ```
   Options: `--platform ios|android`, `--entry <file>`, `--out <dir>`,
   `--sourcemaps`. Add `aeropush-dist/` to your `.gitignore`.
2. Upload the zips to the bundle host referenced by `HARDCODED_UPDATE.downloadUrl`
   (currently `https://ota.cavyiot.com/bundles/{ios,android}.zip`).
3. Run the app in **release mode**, trigger `sync()`, then restart the app —
   it should boot from the downloaded bundle (`Running OTA bundle: yes`).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `'Aeropush' could not be found` (TurboModuleRegistry) | Pod install / Gradle sync didn't run after adding the package, or New Architecture is off. Rebuild the native app. |
| Swift can't find `Aeropush` in AppDelegate | Bridging header missing or not set in **both** Debug and Release build configs (§2.2). |
| Metro `Unable to resolve module react-native-aeropush` | Local install only: add `watchFolders` + `nodeModulesPaths` (§1). |
| tsc `Cannot find module 'react'` errors from SDK sources | Local install only: add the `paths` mappings (§1). |
| Jest `Preset ... not found` / cannot resolve the SDK | Use the virtual mock from §5. |
| Update never applies | You're in a debug build — OTA is release-only by design. |
