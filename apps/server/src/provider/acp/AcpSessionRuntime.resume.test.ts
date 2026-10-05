import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeReplayStatus = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      cursor: Schema.Number,
      total: Schema.Number,
      failure: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

class ReplayStatusPending extends Data.TaggedError("ReplayStatusPending")<{}> {}

const mcpServers = [{ name: "fixture", command: "fixture-mcp", args: [], env: [] }];
const request = (method: string, params: unknown) => ({
  type: "expect_outbound",
  frame: { kind: "request", method, params },
});
const response = (method: string, result: unknown) => ({
  type: "emit_inbound",
  frame: { kind: "response", method, result },
});

describe("missing ACP sessions", () => {
  it.effect.each([
    ["load", "startup"],
    ["load", "activation"],
    ["load", "default-fail"],
    ["load", "other-error"],
    ["resume", "startup"],
    ["resume", "activation"],
    ["resume", "default-fail"],
    ["resume", "other-error"],
  ] as const)(
    "%s %s: replaces only an opted-in -32002 session and retains MCP servers",
    ([method, scenario]) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-acp-resume-" });
        const transcriptPath = path.join(directory, "transcript.json");
        const statusPath = path.join(directory, "status.json");
        const agentPath = yield* path.fromFileUrl(
          new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
        );
        const activation = scenario === "activation";
        const recover = scenario === "startup" || activation;
        const code = scenario === "other-error" ? -32603 : -32002;
        const setupPayload = { cwd: process.cwd(), mcpServers, additionalDirectories: [directory] };
        const entries = [
          request("initialize", "<any>"),
          response("initialize", {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
            authMethods: [],
          }),
          ...(activation
            ? [
                request("session/new", setupPayload),
                response("session/new", { sessionId: "initial" }),
              ]
            : []),
          request(`session/${method}`, {
            sessionId: "gone",
            ...(activation ? { cwd: process.cwd(), mcpServers } : setupPayload),
          }),
          {
            type: "emit_inbound",
            frame: {
              kind: "response",
              method: `session/${method}`,
              error: { code, message: "Session missing" },
            },
          },
          ...(recover
            ? [
                request("session/new", setupPayload),
                response("session/new", {
                  sessionId: "replacement",
                  modes: {
                    currentModeId: "dont_ask",
                    availableModes: [{ id: "dont_ask", name: "Full access" }],
                  },
                }),
                request("session/prompt", {
                  sessionId: "replacement",
                  prompt: [{ type: "text", text: "continue" }],
                }),
                response("session/prompt", { stopReason: "end_turn" }),
              ]
            : []),
        ];
        yield* fs.writeFileString(transcriptPath, yield* encodeJson({ scenario, entries }));
        const runtime = yield* AcpSessionRuntime.make({
          spawn: {
            command: process.execPath,
            args: [agentPath],
            env: {
              T3_ACP_REPLAY_TRANSCRIPT_PATH: transcriptPath,
              T3_ACP_REPLAY_STATUS_PATH: statusPath,
            },
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-hermes-test", version: "0.0.0" },
          mcpServers,
          additionalDirectories: [directory],
          ...(activation ? {} : { resumeSessionId: "gone", resumeMethod: method }),
          ...(scenario === "default-fail" ? {} : { onResumeNotFound: "new-session" as const }),
        });
        const setup = activation
          ? runtime
              .start()
              .pipe(
                Effect.andThen(
                  method === "load"
                    ? runtime.loadSession("gone", { mcpServers })
                    : runtime.resumeSession("gone", { mcpServers }),
                ),
              )
          : runtime.start();
        if (recover) {
          expect(yield* setup).toMatchObject({ sessionId: "replacement" });
          expect(yield* runtime.getModeState).toMatchObject({ currentModeId: "dont_ask" });
          expect(
            yield* runtime.prompt({ prompt: [{ type: "text", text: "continue" }] }),
          ).toMatchObject({ stopReason: "end_turn" });
        } else {
          expect(yield* setup.pipe(Effect.flip)).toMatchObject({ _tag: "AcpRequestError", code });
        }
        // The replay agent rewrites status.json (truncate, then write) after it
        // emits each response, so a read right after the last one can find it
        // empty under load. Read until it holds the final cursor or a failure.
        const status = yield* fs.readFileString(statusPath).pipe(
          Effect.flatMap(decodeReplayStatus),
          Effect.filterOrFail(
            (current) => current.failure !== undefined || current.cursor === current.total,
            () => new ReplayStatusPending(),
          ),
          Effect.retry({ schedule: Schedule.spaced("10 millis"), times: 200 }),
        );
        expect(status.failure).toBeUndefined();
        expect(status.cursor).toBe(status.total);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
