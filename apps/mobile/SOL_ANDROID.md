# Private Sol Android build

This fork's account-free, directly paired Android variant is **T3 Code (Sol)**,
package `zone.pharos.t3code`, scheme `t3code-sol`. It can coexist with the store
app. Set `APP_VARIANT=sol` for both prebuild and Gradle/Metro: the variant forces
OTA, Clerk, relay registration and Firebase configuration off, even if ambient
cloud settings exist. Push notifications are intentionally not configured.

## Requirements

Use Node 24 and the repository's frozen pnpm lockfile. This branch's RN 0.88
requires compile SDK/platform **37.0** and build tools **37.0.0**, while still
targeting API 36 / Android 16. NDK 27.1.12297006, JDK 17, CMake 3.22.1 and Ninja
are needed. Enter `nix-shell apps/mobile/scripts/sol-android.nix` from the repo
root. It supplies these requirements and points Gradle's
`android.aapt2FromMavenOverride` at the SDK's Nix-built aapt2; the Maven binary
is not executable on NixOS. Use a separate API 36 image for emulator testing.
Full October 6 run receipts live in the ignored `.t3/apk/` worktree directory.

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile
cd apps/mobile
APP_VARIANT=sol T3CODE_MOBILE_UPDATES_ENABLED=0 EXPO_NO_DOTENV=1 CI=1 \
  node_modules/.bin/expo prebuild --platform android --no-install
```

Release signing is deliberately **not** the Expo template's debug key. Supply
these Gradle properties (`-P…`) or environment variables:

- `T3_RELEASE_STORE_FILE`: absolute private keystore path.
- `T3_RELEASE_PASSWORD_FILE`: absolute path to a file containing the store/key
  password. Never put the password itself in arguments or repository files.
- `T3_RELEASE_KEY_ALIAS`: optional; defaults to `t3-sol`.

The key and password must be preserved for future updates, outside the repo,
with directory mode 0700 and file mode 0600. Missing signing paths make release
builds fail closed. The first Sol key lives under
`/home/luis/.local/share/pharos-keys/t3-android/`; do not commit or distribute it.

```sh
export APP_VARIANT=sol T3CODE_MOBILE_UPDATES_ENABLED=0 EXPO_NO_DOTENV=1 CI=1
export T3_RELEASE_STORE_FILE=/home/luis/.local/share/pharos-keys/t3-android/t3-sol-release.p12
export T3_RELEASE_PASSWORD_FILE=/home/luis/.local/share/pharos-keys/t3-android/password
cd android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64 \
  -Pandroid.enableMinifyInReleaseBuilds=false \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=false --max-workers=6
```

Dual ABI permits testing the same signed release on an x86_64 emulator and
installing it on an arm64 Pixel. No EAS, Expo, Firebase or Google account is
needed. Verify the output using `apksigner verify --verbose --print-certs` and
check the package/permissions with `aapt2 dump badging` before sharing it.

## Fork parity

- Hermes/OpenClaw names, provider marks, primary model catalogs, instance routing
  and supported access-mode choices. Server health/settings use the existing
  generic provider snapshot controls; provider installation/configuration is
  still managed on the server/web settings surface, not installed from Android.
- Native v2 subagents, named dynamic tool rows and failed-turn errors retain the
  upstream mobile renderer. No server/contracts changes were required.
- Record voice notes from existing-thread and new-task composers only when the
  selected provider advertises `supportsAudioPrompts`. Recording is separate
  from dictation and does not depend on phone-local speech transcription.
- M4A bytes enter the existing durable draft/outbox and upload pipeline. Cancel,
  denied permission and background/unmount release the recorder. Provider-side
  `voice_note_transcript` output appears as a readable transcript, fetching
  withheld historical output when necessary. Audio attachments play inline.

## Pairing and deployment boundary

The server must use this fork's **orchestration protocol v2** build before this
APK can pair with the live Sol service. The October 6 build task did not switch
or alter the live service. In the app choose Add environment, Host
`https://t3.sol.pharos.zone`, and paste a fresh pairing code from that server.
No server address is baked into the APK. Native release deep links cannot
silently prefill host/token; manual pairing or the normal QR scanner is required.

Phone installation is a separate human-authorized action. Do not connect to or
install on Luna as part of build/emulator testing.
