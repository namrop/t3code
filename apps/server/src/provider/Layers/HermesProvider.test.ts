// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HermesSettings } from "@t3tools/contracts";

import {
  buildHermesModelsFromSessionModelState,
  buildInitialHermesProviderSnapshot,
  checkHermesProviderStatus,
} from "./HermesProvider.ts";
import { resetHermesAcpAuthMethodIdCacheForTests } from "../acp/HermesAcpSupport.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeHermesSettings = Schema.decodeSync(HermesSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

// A stand-in for the Hermes CLI: `acp --check` and `acp --version` print
// canned text, and bare `acp` execs the mock ACP agent so `session/new`
// returns model metadata. `env` reaches the mock agent.
const writeFakeHermesCli = (input: {
  readonly acp: boolean;
  readonly env?: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-probe-" });
    const mockAgentPath = NodePath.resolve(__dirname, "../../../scripts/acp-mock-agent.ts");
    return {
      dir,
      hermesPath: writeFakeCli({
        directory: dir,
        name: "hermes",
        ...(input.env ? { env: input.env } : {}),
        source: [
          'if (process.argv[2] !== "acp") process.exit(1);',
          'if (process.argv[3] === "--check") {',
          '  process.stdout.write("Hermes ACP check OK\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[3] === "--version") {',
          '  process.stdout.write("0.21.4\\n");',
          "  process.exit(0);",
          "}",
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      }),
    };
  });

describe("buildHermesModelsFromSessionModelState", () => {
  it("marks the session's current model as default", () => {
    const models = buildHermesModelsFromSessionModelState({
      currentModelId: "grok-4.6",
      availableModels: [
        { modelId: "grok-4.6", name: "Grok 4.6" },
        { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
      ],
    });
    expect(models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
      ["grok-4.6", true],
      ["grok-mock-alt", false],
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("returns no models when the session advertises none", () => {
    expect(buildHermesModelsFromSessionModelState(null)).toEqual([]);
    expect(
      buildHermesModelsFromSessionModelState({ currentModelId: "", availableModels: [] }),
    ).toEqual([]);
  });
});

describe("buildInitialHermesProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a disabled snapshot by default — Hermes is opt-in", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(decodeHermesSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );

  it.effect("returns a pending snapshot when enabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialHermesProviderSnapshot(
        decodeHermesSettings({ enabled: true }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Hermes");
      expect(snapshot.supportsConversationRollback).toBe(false);
    }),
  );
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeHermesSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when `acp --check` exits non-zero", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-check-" });
          const hermesPath = writeFakeCli({
            directory: dir,
            name: "hermes",
            source: [
              'if (process.argv[2] === "acp" && process.argv[3] === "--check") {',
              "  process.exit(2);",
              "}",
              "process.exit(1);",
              "",
            ].join("\n"),
          });

          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("--check` failed");
    }),
  );

  it.effect("reports ready with ACP-discovered models when the session starts", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { hermesPath } = yield* writeFakeHermesCli({ acp: true });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("0.21.4");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Hermes Agent session",
      });
      // The mock agent advertises grok-4.6 + grok-mock-alt via session/new's models field.
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
    }),
  );

  it.effect("falls back to configured models with a warning when the ACP session fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const { hermesPath } = yield* writeFakeHermesCli({ acp: false });
          return yield* checkHermesProviderStatus(
            decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.21.4");
      expect(snapshot.message).toContain("ACP session failed to start");
    }),
  );
});

describe("checkHermesProviderStatus session time limit", () => {
  // Real clock: the probe's time limits have to actually elapse. The mock
  // makes exactly one `initialize` slow (4s, past the 3s session limit),
  // whichever spawn answers it first; deleting the marker file re-arms it.
  it.live("times the session start alone, not the auth-method lookup ahead of it", () =>
    Effect.gen(function* () {
      resetHermesAcpAuthMethodIdCacheForTests();
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-hermes-slow-init-" });
      const markerPath = NodePath.join(stateDir, "delayed");
      const { hermesPath } = yield* writeFakeHermesCli({
        acp: true,
        env: {
          T3_ACP_DELAY_FIRST_INITIALIZE_MS: "4000",
          T3_ACP_DELAY_FIRST_INITIALIZE_STATE_PATH: markerPath,
        },
      });
      const check = checkHermesProviderStatus(
        decodeHermesSettings({ enabled: true, binaryPath: hermesPath }),
        process.env,
        { sessionProbeTimeoutMs: 3000 },
      );

      // Cold cache: the auth-method lookup spawns first and takes the slow
      // initialize. The session spawned after it is fast, so the check is
      // ready even though the whole probe ran past 3s.
      const cold = yield* check;
      expect(cold.status).toBe("ready");
      expect(cold.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);

      // Warm cache: no lookup spawn, so the session's own initialize is the
      // slow one, and the limit still applies to it.
      yield* fs.remove(markerPath);
      const slowSession = yield* check;
      expect(slowSession.status).toBe("warning");
      expect(slowSession.message).toContain("ACP session failed to start");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
