import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "@t3tools/contracts";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as McpClientCredentials from "./McpClientCredentials.ts";

const decodeStoredHash = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ tokenHash: Schema.String })),
);

const TestLayer = McpClientCredentials.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-clients-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("issues persistent hash-only credentials and lists no secret", () =>
  Effect.gen(function* () {
    const store = yield* McpClientCredentials.McpClientCredentials;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const issued = yield* store.issue({ label: "OpenClaw" });
    expect(issued.credential.runtimeModeCeiling).toBe("auto");
    expect(issued.token.length).toBeGreaterThan(40);
    expect(yield* store.resolve(issued.token)).toEqual(issued.credential);
    expect(yield* store.list).toEqual([issued.credential]);
    const directory = path.join(config.stateDir, "mcp-clients");
    const files = yield* fs.readDirectory(directory);
    expect(files).toHaveLength(1);
    const content = yield* fs.readFileString(path.join(directory, files[0]!));
    expect(content).not.toContain(issued.token);
    const stored = yield* decodeStoredHash(content);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    // A second instance represents the CLI / a restarted server, not a cache.
    const other = yield* McpClientCredentials.McpClientCredentials.pipe(
      Effect.provide(McpClientCredentials.layer),
    );
    expect(yield* other.resolve(issued.token)).toEqual(issued.credential);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("revokes across instances immediately without affecting other clients", () =>
  Effect.gen(function* () {
    const store = yield* McpClientCredentials.McpClientCredentials;
    const other = yield* McpClientCredentials.McpClientCredentials.pipe(
      Effect.provide(McpClientCredentials.layer),
    );
    const first = yield* store.issue({ label: "first", runtimeModeCeiling: "approval-required" });
    const second = yield* other.issue({ label: "second", runtimeModeCeiling: "full-access" });
    expect(yield* store.resolve("unknown")).toBeUndefined();
    expect(yield* store.resolve("")).toBeUndefined();
    expect(yield* other.revoke(first.credential.id)).toBe(true);
    expect(yield* store.resolve(first.token)).toBeUndefined();
    expect(yield* store.resolve(second.token)).toEqual(second.credential);
    expect(yield* store.revoke(first.credential.id)).toBe(false);
    expect(yield* store.list).toEqual([second.credential]);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "registry resolves outside clients at their ceiling without provider liveness expiry",
  () =>
    Effect.gen(function* () {
      const store = yield* McpClientCredentials.McpClientCredentials;
      const issued = yield* store.issue({
        label: "OpenClaw",
        runtimeModeCeiling: "auto-accept-edits",
      });
      const registry = yield* McpSessionRegistry.__testing
        .make({ now: () => 999_999_999, livenessWindowMs: 1 })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, {
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
          Effect.provideService(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
            getDescriptor: Effect.die("unused"),
          }),
        );
      const scope = yield* registry.resolve(issued.token);
      expect(scope?.thread).toBeUndefined();
      expect(scope?.client).toEqual({
        sessionId: issued.credential.id,
        label: "OpenClaw",
        runtimeModeCeiling: "auto-accept-edits",
      });
      expect(scope?.requestNamespace).toBe(`client:${issued.credential.id}`);
      expect(scope?.capabilities).toEqual(new Set(["orchestration", "pull-requests"]));
      yield* registry.revokeAll;
      expect(yield* registry.resolve(issued.token)).toEqual(scope);
      yield* store.revoke(issued.credential.id);
      expect(yield* registry.resolve(issued.token)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("does not lose concurrently issued credentials", () =>
  Effect.gen(function* () {
    const store = yield* McpClientCredentials.McpClientCredentials;
    const issued = yield* Effect.all(
      Array.from({ length: 8 }, (_, i) => store.issue({ label: `client-${i}` })),
      { concurrency: "unbounded" },
    );
    expect(yield* store.list).toHaveLength(8);
    for (const client of issued) {
      expect(yield* store.resolve(client.token)).toEqual(client.credential);
    }
  }).pipe(Effect.provide(TestLayer)),
);
