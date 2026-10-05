import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { HermesDriver } from "./HermesDriver.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

describe("HermesDriver", () => {
  it("registers a dedicated legacy-compatible default instance", () => {
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === HermesDriver.driverKind)).toBe(true);
    expect(defaultInstanceIdForDriver(HermesDriver.driverKind)).toBe("hermes");
    expect(HermesDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "hermes",
      homePath: "",
      customModels: [],
    });
  });
  it.effect(
    "discovers old-style models once without a cold auth-method probe",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-hermes-driver-fixture-",
        });
        const binaryPath = path.join(directory, "hermes");
        const transcriptPath = path.join(directory, "transcript.json");
        const mockAgent = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
        );
        yield* fs.writeFileString(
          binaryPath,
          `#!/bin/sh\nexec '${process.execPath}' --experimental-strip-types '${mockAgent}' "$@"\n`,
        );
        yield* fs.chmod(binaryPath, 0o700);
        yield* fs.writeFileString(
          transcriptPath,
          yield* encodeJson({
            provider: "hermes",
            protocol: "acp.ndjson-jsonrpc",
            version: "1",
            scenario: "hermes-model-discovery",
            entries: [
              {
                type: "expect_outbound",
                frame: { kind: "request", method: "initialize", params: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: {
                  kind: "response",
                  method: "initialize",
                  result: {
                    protocolVersion: 1,
                    agentCapabilities: { loadSession: true },
                    authMethods: [],
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: { kind: "request", method: "session/new", params: "<any>" },
              },
              {
                type: "emit_inbound",
                frame: {
                  kind: "response",
                  method: "session/new",
                  result: {
                    sessionId: "hermes-fixture",
                    models: {
                      currentModelId: "anthropic:fixture",
                      availableModels: [{ modelId: "anthropic:fixture", name: "Fixture" }],
                    },
                  },
                },
              },
            ],
          }),
        );
        const instance = yield* HermesDriver.create({
          instanceId: ProviderInstanceId.make("hermes"),
          displayName: "Hermes fixture",
          enabled: true,
          config: {
            ...HermesDriver.defaultConfig(),
            binaryPath,
            homePath: directory,
            customModels: ["custom:fixture"],
          },
          environment: [
            { name: "T3_ACP_REPLAY_TRANSCRIPT_PATH", value: transcriptPath, sensitive: false },
            {
              name: "T3_ACP_REPLAY_STATUS_PATH",
              value: path.join(directory, "status.json"),
              sensitive: false,
            },
          ],
        });
        const first = yield* Stream.runHead(instance.snapshot.streamChanges);
        expect(Option.isSome(first)).toBe(true);
        const snapshot = yield* instance.snapshot.getSnapshot;
        expect(snapshot).toMatchObject({
          driver: "hermes",
          instanceId: "hermes",
          status: "ready",
          displayName: "Hermes fixture",
        });
        expect(snapshot.models.map((m) => m.slug)).toContain("anthropic:fixture");
        expect(snapshot.models).toContainEqual(
          expect.objectContaining({ slug: "custom:fixture", isCustom: true }),
        );
        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models).toEqual(snapshot.models);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    { timeout: 30_000 },
  );
});
