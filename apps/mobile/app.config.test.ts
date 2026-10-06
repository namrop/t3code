import { afterEach, expect, it, vi } from "vite-plus/test";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("isolates the Sol APK even when ambient cloud settings are present", async () => {
  vi.stubEnv("APP_VARIANT", "sol");
  vi.stubEnv("T3CODE_RELAY_URL", "https://relay.example.test");
  vi.stubEnv("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_not_real");
  vi.stubEnv("T3CODE_ANDROID_GOOGLE_SERVICES_FILE", "/no/firebase.json");
  const { default: config } = await import("./app.config");
  expect(config.android?.package).toBe("zone.pharos.t3code");
  expect(config.name).toBe("T3 Code (Sol)");
  expect(config.scheme).toBe("t3code-sol");
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.android?.googleServicesFile).toBeUndefined();
  expect(config.extra?.clerk.publishableKey).toBeNull();
  expect(config.extra?.relay.url).toBeNull();
  expect(config.extra?.eas).toBeUndefined();
  const imagePicker = config.plugins?.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-image-picker",
  );
  expect(Array.isArray(imagePicker) && typeof imagePicker[1].microphonePermission).toBe("string");
});
