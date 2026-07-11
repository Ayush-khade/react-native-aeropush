//
//  AppDelegate.swift  (example app)
//
//  Shows the ONE integration point AeroPush needs on iOS: override the
//  bundle URL so the app boots from the active OTA bundle when one is staged,
//  falling back to the binary's embedded bundle otherwise.
//
//  Everything else (download, unzip, rollback, crash counter) is handled by
//  the SDK — this hook is all the host app writes.
//

import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

// The SDK's Obj-C++ class is exposed to Swift via the bridging header
// (see AeroPush-Bridging-Header.h). `Aeropush.bundleURL()` runs the Layer-1
// launch-counter check and returns the OTA bundle or nil.

@main
class AppDelegate: RCTAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    self.moduleName = "AeroPushExample"
    self.dependencyProvider = RCTAppDependencyProvider()
    self.initialProps = [:]
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    return self.bundleURL()
  }

  override func bundleURL() -> URL? {
    #if DEBUG
      // Development: always load from Metro so Fast Refresh works. OTA is a
      // release-only concern.
      return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
    #else
      // Production: prefer the active OTA bundle; fall back to the embedded
      // main.jsbundle when there isn't one (or after a rollback-to-binary).
      if let otaURL = Aeropush.bundleURL() {
        return otaURL
      }
      return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
    #endif
  }
}
