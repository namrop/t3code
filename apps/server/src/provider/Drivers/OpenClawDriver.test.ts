import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { OpenClawDriver } from "./OpenClawDriver.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-openclaw-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
);

describe("OpenClawDriver", () => {
  it("registers a dedicated legacy-compatible default instance", () => {
    expect(BUILT_IN_DRIVERS.some((d) => d.driverKind === OpenClawDriver.driverKind)).toBe(true);
    expect(defaultInstanceIdForDriver(OpenClawDriver.driverKind)).toBe("openclaw");
    expect(OpenClawDriver.defaultConfig()).toEqual({
      enabled: false,
      binaryPath: "openclaw",
      agentId: "main",
      customModels: [],
    });
  });
  it.effect.each([true, false])(
    "discovers configured models with access support %s and keeps the default when reopening a pinned thread",
    (accessSupported) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-openclaw-driver-fixture-",
        });
        const binaryPath = path.join(directory, "openclaw");
        const transcriptPath = path.join(directory, "transcript.json");
        const mockAgent = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
        );
        yield* fs.writeFileString(
          binaryPath,
          `#!/bin/sh\nexec '${process.execPath}' --experimental-strip-types '${mockAgent}' "$@"\n`,
        );
        yield* fs.chmod(binaryPath, 0o700);
        const transcript = (model: string, method: "session/new" | "session/load") => ({
          provider: "openclaw",
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "openclaw-model-discovery",
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
                  agentCapabilities: {
                    loadSession: true,
                    promptCapabilities: { image: true, audio: true },
                  },
                  authMethods: [],
                },
              },
            },
            {
              type: "expect_outbound",
              frame: { kind: "request", method, params: "<any>" },
            },
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method,
                result: {
                  sessionId: "openclaw-fixture",
                  configOptions: [
                    {
                      id: "model",
                      category: "model",
                      type: "select",
                      name: "Model",
                      currentValue: model,
                      options: [
                        { value: "anthropic/fixture", name: "Fixture" },
                        { value: "openai/resumed", name: "Resumed" },
                      ],
                    },
                    ...(accessSupported
                      ? [
                          {
                            id: "permission_mode",
                            type: "select",
                            name: "Access",
                            currentValue: "full",
                            options: [{ value: "full", name: "Full" }],
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
          ],
        });
        yield* fs.writeFileString(
          transcriptPath,
          yield* encodeJson(transcript("anthropic/fixture", "session/new")),
        );
        // The discovery cache uses zero as its never-probed sentinel.
        yield* TestClock.adjust("1 millis");
        const instance = yield* OpenClawDriver.create({
          instanceId: ProviderInstanceId.make("openclaw"),
          displayName: "OpenClaw fixture",
          enabled: true,
          config: {
            ...OpenClawDriver.defaultConfig(),
            binaryPath,
            agentId: "fixture",
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
          driver: "openclaw",
          instanceId: "openclaw",
          status: accessSupported ? "ready" : "warning",
          displayName: "OpenClaw fixture",
          supportsAudioPrompts: true,
        });
        if (!accessSupported) expect(snapshot.message).toContain("T3 access modes are unavailable");
        expect(snapshot.models.map((m) => m.slug)).toContain("anthropic/fixture");
        expect(snapshot.models).toContainEqual(
          expect.objectContaining({ slug: "custom:fixture", isCustom: true }),
        );
        yield* instance.snapshot.refresh;
        expect((yield* instance.snapshot.getSnapshot).models).toEqual(snapshot.models);
        yield* fs.writeFileString(
          transcriptPath,
          yield* encodeJson(transcript("openai/resumed", "session/load")),
        );
        yield* instance.orchestrationAdapter.openSession({
          threadId: ThreadId.make("thread-openclaw-resumed"),
          providerSessionId: ProviderSessionId.make("session-openclaw-resumed"),
          initialNativeThreadId: "openclaw-fixture",
          modelSelection: { instanceId: instance.instanceId, model: "openai/resumed" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: directory,
          },
        });
        expect(
          (yield* instance.snapshot.getSnapshot).models
            .filter((m) => m.isDefault)
            .map((m) => m.slug),
        ).toEqual(["anthropic/fixture"]);
        yield* instance.snapshot.refresh;
        const resumedSnapshot = yield* instance.snapshot.getSnapshot;
        expect(resumedSnapshot.models.filter((m) => m.isDefault).map((m) => m.slug)).toEqual([
          "anthropic/fixture",
        ]);
        expect(resumedSnapshot.status).toBe(accessSupported ? "ready" : "warning");
        if (!accessSupported)
          expect(resumedSnapshot.message).toContain("T3 access modes are unavailable");
      }).pipe(Effect.provide(testLayer), Effect.scoped),
    { timeout: 30_000 },
  );
});
