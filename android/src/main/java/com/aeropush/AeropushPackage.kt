package com.aeropush

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers [AeropushModule] with React Native.
 *
 * Extends [BaseReactPackage] (the New Architecture package base). The
 * [getReactModuleInfoProvider] entry advertises the module as a TurboModule
 * so the runtime resolves it through the JSI TurboModule path rather than the
 * legacy bridge.
 */
class AeropushPackage : BaseReactPackage() {

  override fun getModule(
    name: String,
    reactContext: ReactApplicationContext
  ): NativeModule? {
    return if (name == AeropushModule.NAME) {
      AeropushModule(reactContext)
    } else {
      null
    }
  }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
    return ReactModuleInfoProvider {
      mapOf(
        AeropushModule.NAME to ReactModuleInfo(
          AeropushModule.NAME,          // name
          AeropushModule.NAME,          // className
          false,                        // canOverrideExistingModule
          false,                        // needsEagerInit
          false,                        // isCxxModule
          true                          // isTurboModule
        )
      )
    }
  }
}
