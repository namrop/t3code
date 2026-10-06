import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { RuntimeMode } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { cli } from "../binCli.ts";

const Credential = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  runtimeModeCeiling: RuntimeMode,
  issuedAt: Schema.Number,
});
const decodeIssued = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String, credential: Credential })),
);
const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Credential)));

it.effect("CLI issues once, lists without tokens, and revokes persistent MCP clients", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-cli-" });
    const run = (args: string[]) => Command.runWith(cli, { version: "0.0.0" })(args);
    const lastLine = TestConsole.logLines.pipe(Effect.map((lines) => lines.at(-1)));
    yield* run(["mcp", "client", "issue", "--label", "OpenClaw", "--base-dir", baseDir]);
    const issued = decodeIssued(yield* lastLine);
    expect(issued.credential.runtimeModeCeiling).toBe("auto");
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    yield* run(["mcp", "client", "list", "--base-dir", baseDir]);
    const listed = yield* lastLine;
    expect(decodeList(listed)).toEqual([issued.credential]);
    expect(listed).not.toContain(issued.token);
    yield* run(["mcp", "client", "revoke", issued.credential.id, "--base-dir", baseDir]);
    expect(yield* lastLine).toContain('"revoked":true');
    yield* run(["mcp", "client", "list", "--base-dir", baseDir]);
    expect(decodeList(yield* lastLine)).toEqual([]);
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
  ),
);
