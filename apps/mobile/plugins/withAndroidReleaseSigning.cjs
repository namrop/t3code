const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING = `
    signingConfigs {
        solRelease {
            def value = { name -> project.findProperty(name) ?: System.getenv(name) }
            def storePath = value('T3_RELEASE_STORE_FILE')
            def passwordPath = value('T3_RELEASE_PASSWORD_FILE')
            def releaseRequested = gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }
            if (releaseRequested && (!storePath || !passwordPath)) {
                throw new GradleException('Sol release needs T3_RELEASE_STORE_FILE and T3_RELEASE_PASSWORD_FILE; debug-key fallback is forbidden.')
            }
            if (storePath && passwordPath) {
                storeFile file(storePath)
                def password = file(passwordPath).text.trim()
                storePassword password
                keyPassword password
                keyAlias value('T3_RELEASE_KEY_ALIAS') ?: 't3-sol'
            }
        }
    }
`;
function applyReleaseSigning(source) {
  if (source.includes("signingConfigs.solRelease")) return source;
  const release = /release\s*\{[\s\S]*?signingConfig signingConfigs\.debug/;
  if (!release.test(source))
    throw new Error("Expo release signing template changed; refusing an unsafe APK.");
  return source
    .replace("    buildTypes {", `${SIGNING}\n    buildTypes {`)
    .replace(release, (match) =>
      match.replace("signingConfigs.debug", "signingConfigs.solRelease"),
    );
}
module.exports = (config) =>
  withAppBuildGradle(config, (next) => {
    next.modResults.contents = applyReleaseSigning(next.modResults.contents);
    return next;
  });
module.exports.applyReleaseSigning = applyReleaseSigning;
