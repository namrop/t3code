# Run from the repository root: nix-shell apps/mobile/scripts/sol-android.nix
let
  pkgs = import <nixpkgs> { config.allowUnfree = true; config.android_sdk.accept_license = true; };
  android = pkgs.androidenv.composeAndroidPackages {
    # RN 0.88 compiles with 37.0 but targets 36 (Android 16).
    platformVersions = [ "36" "37.0" ];
    buildToolsVersions = [ "36.0.0" "37.0.0" ];
    includeEmulator = false;
    includeSystemImages = false;
    includeNDK = true;
    ndkVersions = [ "27.1.12297006" ];
    cmakeVersions = [ "3.22.1" ];
    includeSources = false;
  };
  sdk = "${android.androidsdk}/libexec/android-sdk";
in pkgs.mkShell {
  packages = [ pkgs.nodejs_24 pkgs.jdk17 pkgs.python3 pkgs.gnumake pkgs.gcc pkgs.cmake pkgs.ninja pkgs.pkg-config android.androidsdk pkgs.apksigner ];
  JAVA_HOME = "${pkgs.jdk17}";
  ANDROID_HOME = sdk;
  ANDROID_SDK_ROOT = sdk;
  GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/37.0.0/aapt2 -Dorg.gradle.daemon=false";
}
