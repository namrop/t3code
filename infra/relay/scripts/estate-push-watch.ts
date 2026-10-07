// @effect-diagnostics nodeBuiltinImport:off - Read operator credentials, never log them.
import * as NodeFSP from "node:fs/promises";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { EventJournal } from "./estatePushJournal.ts";
export { EventJournal } from "./estatePushJournal.ts";

async function main() {
  const [configPath] = process.argv.slice(2);
  if (!configPath) throw new Error("Usage: estate-push-watch <config.json>");
  const config = JSON.parse(await NodeFSP.readFile(configPath, "utf8")) as {
    wsUrl: string;
    bearerTokenFile: string;
    publisherTokenFile: string;
    senderUrl: string;
    database: string;
  };
  if (!/^http:\/\/127\.0\.0\.1:\d+\/v1\/events$/.test(config.senderUrl))
    throw new Error("Sender must be loopback-bound");
  const token = (await NodeFSP.readFile(config.bearerTokenFile, "utf8")).trim();
  const publisher = (await NodeFSP.readFile(config.publisherTokenFile, "utf8")).trim();
  const journal = new EventJournal(config.database);

  const socketConstructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url, protocols) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols as string | string[] | undefined, {
        headers: { authorization: `Bearer ${token}` },
      }) as unknown as globalThis.WebSocket,
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(config.wsUrl).pipe(Layer.provide(socketConstructor))),
    Layer.provide(RpcSerialization.layerJson),
  );
  const watch = Effect.gen(function* () {
    const rpc = yield* RpcClient.make(WsRpcGroup);
    const server = yield* rpc[WS_METHODS.serverGetConfig]({});
    const projects = new Map<string, OrchestrationProjectShell>();
    const threads = new Map<string, OrchestrationV2ThreadShell>();
    yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          if (item.kind === "synchronized") return;
          if (item.kind === "snapshot") {
            projects.clear();
            threads.clear();
            for (const p of item.snapshot.projects) projects.set(p.id, p);
            for (const t of item.snapshot.threads) threads.set(t.id, t);
          } else if (item.kind === "project.updated") projects.set(item.project.id, item.project);
          else if (item.kind === "project.removed") projects.delete(item.projectId);
          else if (item.kind === "thread.updated") threads.set(item.thread.id, item.thread);
          else if (item.kind === "thread.removed") {
            threads.delete(item.threadId);
            journal.observe(null, item.threadId, false);
          }
          const candidates =
            item.kind === "thread.updated"
              ? [item.thread]
              : item.kind === "snapshot"
                ? [...threads.values()]
                : [];
          for (const thread of candidates) {
            const project = projects.get(thread.projectId);
            const state =
              project && !thread.archivedAt
                ? projectThreadAwarenessV2({
                    environmentId: server.environment.environmentId,
                    project,
                    thread,
                  })
                : null;
            journal.observe(state, thread.id, item.kind === "snapshot");
          }
        }),
      ),
    );
  }).pipe(Effect.provide(protocol), Effect.scoped);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: () => journal.flush(config.senderUrl, publisher),
            catch: () => "Ingestion unavailable",
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.andThen(Effect.sleep("1 second")),
            Effect.forever,
            Effect.forkScoped,
          );
          return yield* watch.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("T3 push watcher disconnected; reconnecting."),
            ),
            Effect.andThen(Effect.sleep("5 seconds")),
            Effect.forever,
          );
        }),
      ),
    );
  } finally {
    journal.db.close();
  }
}

// Importing the journal in tests must not start a connection.
if (
  process.argv[1]?.endsWith("estate-push-watch.ts") ||
  process.argv[1]?.endsWith("estate-push-watch.mjs")
) {
  void main().catch(() => {
    Effect.runSync(Effect.logError("T3 push watcher failed; check private configuration."));
    process.exitCode = 1;
  });
}
