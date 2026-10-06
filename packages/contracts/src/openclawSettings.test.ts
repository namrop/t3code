import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";
const decodeSettings = Schema.decodeSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodePatch = Schema.decodeSync(ServerSettingsPatch);

describe("OpenClaw settings", () => {
  it("defaults to an opt-in main agent", () => {
    expect(decodeSettings({}).providers.openclaw).toEqual({
      enabled: false,
      binaryPath: "openclaw",
      agentId: "main",
      customModels: [],
    });
  });
  it("round-trips and patches the default instance", () => {
    const config = {
      enabled: true,
      binaryPath: "/bin/openclaw",
      agentId: "coding",
      customModels: ["openai/gpt-6-sol"],
    };
    const decoded = decodeSettings({ providers: { openclaw: config } });
    expect(encodeSettings(decoded).providers?.openclaw).toEqual(config);
    const patch = { providers: { openclaw: { agentId: "coding" } } };
    expect(decodePatch(patch)).toEqual(patch);
  });
});
