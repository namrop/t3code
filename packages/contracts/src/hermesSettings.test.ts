import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("Hermes legacy settings compatibility", () => {
  it("round-trips the fork's providers.hermes and colon-delimited models", () => {
    const input = {
      providers: {
        hermes: {
          enabled: true,
          binaryPath: "/bin/hermes",
          homePath: "/var/lib/hermes/primary",
          customModels: ["anthropic:claude-opus-5-5"],
        },
      },
      defaultModelSelection: { instanceId: "hermes", model: "anthropic:claude-opus-5-5" },
      textGenerationModelSelection: { instanceId: "hermes", model: "openai-codex:gpt-6-luna" },
    };
    const decoded = decodeSettings(input);
    const encoded = encodeSettings(decoded);
    expect(encoded.providers).toMatchObject(input.providers);
    expect(encoded.defaultModelSelection).toEqual(input.defaultModelSelection);
    expect(encoded.textGenerationModelSelection).toEqual(input.textGenerationModelSelection);
  });
  it("keeps Hermes patches under providers.hermes", () => {
    expect(
      decodePatch({
        providers: { hermes: { homePath: "/home/test/hermes", enabled: true } },
      }),
    ).toEqual({ providers: { hermes: { homePath: "/home/test/hermes", enabled: true } } });
  });
});
