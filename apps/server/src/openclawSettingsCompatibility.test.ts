import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, OpenClawSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import * as ServerSettings from "./serverSettings.ts";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeOpenClawSettings = Schema.decodeUnknownEffect(OpenClawSettings);

const persistedLayer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-openclaw-settings-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("persists the complete legacy OpenClaw block through an instance save and reload", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const legacy = {
      enabled: true,
      binaryPath: "openclaw",
      agentId: "coding",
      customModels: [],
    };
    yield* service.updateSettings({ providers: { openclaw: legacy } });
    const saved = yield* service.updateProviderInstance(
      {
        operation: "upsert",
        instanceId: ProviderInstanceId.make("openclaw"),
        instance: { driver: ProviderDriverKind.make("openclaw"), enabled: true, config: legacy },
      },
      { providers: { openclaw: { enabled: false, binaryPath: "openclaw", agentId: "" } } },
    );
    expect(saved.providers.openclaw).toEqual(legacy);
    const disk = yield* decodeJson(yield* fs.readFileString(settingsPath));
    expect(disk).toMatchObject({
      providers: { openclaw: legacy },
      providerInstances: { openclaw: { driver: "openclaw", enabled: true } },
    });
    // A fresh production service reads the shared file, not the in-memory test stub.
    const reloaded = yield* ServerSettings.ServerSettingsService.use(
      (next) => next.getSettings,
    ).pipe(
      Effect.provide(
        Layer.fresh(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
      ),
    );
    expect(reloaded.providers.openclaw).toEqual(legacy);
    expect(reloaded.providerInstances[ProviderInstanceId.make("openclaw")]).toMatchObject({
      driver: "openclaw",
      enabled: true,
      config: { agentId: legacy.agentId },
    });
    expect(yield* decodeOpenClawSettings(reloaded.providers.openclaw)).toEqual(legacy);
    const disabled = yield* service.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make("openclaw"),
      instance: {
        driver: ProviderDriverKind.make("openclaw"),
        enabled: false,
        config: { binaryPath: "openclaw", agentId: "", customModels: [] },
      },
    });
    expect(disabled.providers.openclaw).toEqual({ ...legacy, enabled: false, agentId: "" });
    expect(yield* decodeJson(yield* fs.readFileString(settingsPath))).toMatchObject({
      providers: { openclaw: disabled.providers.openclaw },
    });
  }).pipe(Effect.provide(persistedLayer), Effect.scoped),
);
it.effect(
  "does not replace default OpenClaw settings when another OpenClaw account is edited",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const before = yield* settings.getSettings;
      const next = yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: ProviderInstanceId.make("openclaw_other"),
        instance: {
          driver: ProviderDriverKind.make("openclaw"),
          enabled: true,
          config: { binaryPath: "/other/bin/openclaw", agentId: "/other/home" },
        },
      });
      expect(next.providers.openclaw).toEqual(before.providers.openclaw);
    }).pipe(Effect.provide(ServerSettings.layerTest())),
);
