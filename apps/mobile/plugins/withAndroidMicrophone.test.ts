import { createRequire } from "node:module";
import { expect, it } from "vite-plus/test";
const { allowMicrophone } = createRequire(import.meta.url)("./withAndroidMicrophone.cjs");
it("overrides camera and image-picker removal without broadening other permissions", () => {
  const result = allowMicrophone({
    "uses-permission": [
      { $: { "android:name": "android.permission.RECORD_AUDIO", "tools:node": "remove" } },
      { $: { "android:name": "android.permission.ACTIVITY_RECOGNITION", "tools:node": "remove" } },
      { $: { "android:name": "android.permission.INTERNET" } },
    ],
  });
  expect(
    result["uses-permission"].filter(
      (p: any) => p.$["android:name"] === "android.permission.RECORD_AUDIO",
    ),
  ).toEqual([{ $: { "android:name": "android.permission.RECORD_AUDIO" } }]);
  expect(result["uses-permission"]).toContainEqual({
    $: { "android:name": "android.permission.ACTIVITY_RECOGNITION", "tools:node": "remove" },
  });
  expect(allowMicrophone(result)).toEqual(result);
});
