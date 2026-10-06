import { RuntimeMode } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as McpClientCredentials from "../mcp/McpClientCredentials.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

const runWithCredentials = <A, E>(
  flags: CliAuthLocationFlags,
  run: (store: McpClientCredentials.McpClientCredentials["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
    return yield* McpClientCredentials.McpClientCredentials.pipe(
      Effect.flatMap(run),
      Effect.provide(McpClientCredentials.layer.pipe(Layer.provide(ServerConfig.layer(config)))),
    );
  });

const issueCommand = Command.make("issue", {
  ...authLocationFlags,
  label: Flag.String("label").pipe(Flag.withDescription("Name of the outside agent or harness.")),
  runtimeModeCeiling: Flag.Literals("runtime-mode-ceiling", RuntimeMode.literals).pipe(
    Flag.withDefault("auto"),
    Flag.withDescription("Maximum thread permission mode; default: auto."),
  ),
  tokenOnly: Flag.Boolean("token-only").pipe(Flag.withDefault(false)),
}).pipe(
  Command.withDescription(
    "Issue a long-lived MCP bearer token; printed once, stored only as a hash.",
  ),
  Command.withHandler((flags) =>
    runWithCredentials(flags, (store) =>
      store
        .issue(flags)
        .pipe(
          Effect.flatMap((issued) =>
            Console.log(flags.tokenOnly ? issued.token : JSON.stringify(issued)),
          ),
        ),
    ),
  ),
);

const listCommand = Command.make("list", authLocationFlags).pipe(
  Command.withDescription("List MCP client credential metadata, without tokens or hashes."),
  Command.withHandler((flags) =>
    runWithCredentials(flags, (store) =>
      store.list.pipe(Effect.flatMap((credentials) => Console.log(JSON.stringify(credentials)))),
    ),
  ),
);

const revokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id"),
}).pipe(
  Command.withDescription("Revoke an MCP client by id; effective on its next request."),
  Command.withHandler((flags) =>
    runWithCredentials(flags, (store) =>
      store
        .revoke(flags.id)
        .pipe(Effect.flatMap((revoked) => Console.log(JSON.stringify({ id: flags.id, revoked })))),
    ),
  ),
);

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Manage outside MCP clients of this T3 Code environment."),
  Command.withSubcommands([
    Command.make("client").pipe(
      Command.withSubcommands([issueCommand, listCommand, revokeCommand]),
    ),
  ]),
);
