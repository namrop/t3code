import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe("ACP model option authority", () => {
  it.live.each(["model", "reasoning"])(
    "%s select uses the correct authority for unlisted values",
    (category) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-authority-" });
        const transcriptPath = path.join(directory, "transcript.json");
        const agentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
        );
        const option = {
          id: category,
          name: category,
          category,
          type: "select",
          currentValue: "listed",
          options: [{ value: "listed", name: "Listed" }],
        };
        const request = (method: string, params: unknown) => ({
          type: "expect_outbound",
          frame: { kind: "request", method, params },
        });
        const response = (method: string, result: unknown) => ({
          type: "emit_inbound",
          frame: { kind: "response", method, result },
        });
        yield* fs.writeFileString(
          transcriptPath,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            provider: "fixture",
            protocol: "acp.ndjson-jsonrpc",
            version: "1",
            scenario: "model-authority",
            entries: [
              request("initialize", "<any>"),
              response("initialize", {
                protocolVersion: 1,
                agentCapabilities: {},
                authMethods: [],
              }),
              request("session/new", "<any>"),
              response("session/new", { sessionId: "fixture", configOptions: [option] }),
              ...(category === "model"
                ? [
                    request("session/set_config_option", {
                      sessionId: "fixture",
                      configId: category,
                      value: "custom/unlisted",
                    }),
                    response("session/set_config_option", {
                      configOptions: [{ ...option, currentValue: "custom/unlisted" }],
                    }),
                  ]
                : []),
            ],
          }),
        );
        const runtime = yield* AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: ["--experimental-strip-types", agentPath],
            cwd: process.cwd(),
            env: {
              T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
              T3_ACP_REPLAY_STATUS_PATH: path.join(directory, "status.json"),
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-model-test", version: "0" },
          mcpServers: [],
        });
        yield* runtime.start();
        if (category === "model") {
          yield* runtime.setConfigOption(category, "custom/unlisted");
          expect((yield* runtime.getConfigOptions)[0]?.currentValue).toBe("custom/unlisted");
        } else {
          expect(
            yield* runtime.setConfigOption(category, "custom/unlisted").pipe(Effect.flip),
          ).toMatchObject({ _tag: "AcpRequestError", code: -32602 });
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
