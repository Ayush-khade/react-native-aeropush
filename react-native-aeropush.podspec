require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "react-native-aeropush"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => "13.4" }
  s.source       = { :git => "https://github.com/aeropush/react-native-aeropush.git", :tag => "#{s.version}" }

  # Obj-C++ sources. The generated Codegen spec (AeropushSpec) is added to the
  # build automatically by React Native's `install_modules_dependencies`
  # helper below when the New Architecture is enabled.
  s.source_files = "ios/**/*.{h,m,mm,cpp}"

  # zlib ships with iOS; we link it for the from-scratch DEFLATE inflate used
  # by unzipFile. This keeps unzip dependency-free (no SSZipArchive etc).
  s.libraries = "z"

  # This single helper (RN 0.71+) wires up all the required dependencies
  # (React-Core, ReactCommon, the generated codegen target, JSI, etc.) and
  # sets the correct compiler flags for both Old and New Architecture. It
  # replaces the ~30 lines of manual dependency + flag configuration that
  # older templates used.
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    # Fallback for very old React Native versions (pre-0.71). We target
    # 0.76+ so this branch should never run, but it keeps the pod from
    # hard-failing if someone experiments on an older setup.
    s.dependency "React-Core"
  end
end
