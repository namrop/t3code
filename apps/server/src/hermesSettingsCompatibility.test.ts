import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, HermesSettings } from "@t3tools/contracts";
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
const decodeHermesSettings = Schema.decodeUnknownEffect(HermesSettings);

const persistedLayer = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hermes-settings-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("persists the complete legacy Hermes block through an instance save and reload", () =>
  Effect.gen(function* () {
    const service = yield* ServerSettings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const { settingsPath } = yield* ServerConfig.ServerConfig;
    const legacy = {
      enabled: true,
      binaryPath: "hermes",
      homePath: "/hermes-test",
      customModels: [],
    };
    yield* service.updateSettings({ providers: { hermes: legacy } });
    const saved = yield* service.updateProviderInstance(
      {
        operation: "upsert",
        instanceId: ProviderInstanceId.make("hermes"),
        instance: { driver: ProviderDriverKind.make("hermes"), enabled: true, config: legacy },
      },
      { providers: { hermes: { enabled: false, binaryPath: "hermes", homePath: "" } } },
    );
    expect(saved.providers.hermes).toEqual(legacy);
    const disk = yield* decodeJson(yield* fs.readFileString(settingsPath));
    expect(disk).toMatchObject({
      providers: { hermes: legacy },
      providerInstances: { hermes: { driver: "hermes", enabled: true } },
    });
    // A fresh production service reads the shared file, not the in-memory test stub.
    const reloaded = yield* ServerSettings.ServerSettingsService.use(
      (next) => next.getSettings,
    ).pipe(
      Effect.provide(
        Layer.fresh(ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer))),
      ),
    );
    expect(reloaded.providers.hermes).toEqual(legacy);
    expect(reloaded.providerInstances[ProviderInstanceId.make("hermes")]).toMatchObject({
      driver: "hermes",
      enabled: true,
      config: { homePath: legacy.homePath },
    });
    expect(yield* decodeHermesSettings(reloaded.providers.hermes)).toEqual(legacy);
    const disabled = yield* service.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make("hermes"),
      instance: {
        driver: ProviderDriverKind.make("hermes"),
        enabled: false,
        config: { binaryPath: "hermes", homePath: "", customModels: [] },
      },
    });
    expect(disabled.providers.hermes).toEqual({ ...legacy, enabled: false, homePath: "" });
    expect(yield* decodeJson(yield* fs.readFileString(settingsPath))).toMatchObject({
      providers: { hermes: disabled.providers.hermes },
    });
  }).pipe(Effect.provide(persistedLayer), Effect.scoped),
);

it.effect(
  "keeps default Hermes settings in the old build's providers.hermes block after instance edits",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const next = yield* settings.updateProviderInstance(
        {
          operation: "upsert",
          instanceId: ProviderInstanceId.make("hermes"),
          instance: {
            driver: ProviderDriverKind.make("hermes"),
            enabled: true,
            config: {
              binaryPath: "/bin/hermes-test",
              homePath: "/hermes-test",
              customModels: ["custom:one"],
            },
          },
        },
        { providers: { hermes: { enabled: false, binaryPath: "hermes", homePath: "" } } },
      );
      expect(next.providers.hermes).toMatchObject({
        enabled: true,
        binaryPath: "/bin/hermes-test",
        homePath: "/hermes-test",
        customModels: ["custom:one"],
      });
      // The legacy block stays authoritative when the old build edits the shared file.
      const updated = yield* settings.updateSettings({
        providers: { hermes: { homePath: "/edited-by-old", enabled: false } },
      });
      expect(updated.providerInstances[ProviderInstanceId.make("hermes")]).toMatchObject({
        enabled: false,
        config: { homePath: "/edited-by-old", binaryPath: "/bin/hermes-test" },
      });
    }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("does not replace default Hermes settings when another Hermes account is edited", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const before = yield* settings.getSettings;
    const next = yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: ProviderInstanceId.make("hermes_other"),
      instance: {
        driver: ProviderDriverKind.make("hermes"),
        enabled: true,
        config: { binaryPath: "/other/bin/hermes", homePath: "/other/home" },
      },
    });
    expect(next.providers.hermes).toEqual(before.providers.hermes);
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);
