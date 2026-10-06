const { withAndroidManifest } = require("expo/config-plugins");
function allowMicrophone(manifest) {
  // Camera/QR and image-picker disable their own audio capture by removing the
  // permission globally. Native voice notes still require the shared permission.
  manifest["uses-permission"] = (manifest["uses-permission"] ?? []).filter(
    (entry) => entry.$?.["android:name"] !== "android.permission.RECORD_AUDIO",
  );
  manifest["uses-permission"].push({ $: { "android:name": "android.permission.RECORD_AUDIO" } });
  return manifest;
}
module.exports = (config) =>
  withAndroidManifest(config, (next) => {
    next.modResults.manifest = allowMicrophone(next.modResults.manifest);
    return next;
  });
module.exports.allowMicrophone = allowMicrophone;
