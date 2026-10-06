import { RuntimeMode } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const Credential = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  runtimeModeCeiling: RuntimeMode,
  issuedAt: Schema.Number,
});
type Credential = typeof Credential.Type;
const StoredCredential = Schema.Struct({
  ...Credential.fields,
  tokenHash: Schema.String,
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCredential));
const encode = Schema.encodeEffect(Schema.fromJsonString(StoredCredential));

export class McpClientCredentialError extends Schema.TaggedError<McpClientCredentialError>()(
  "McpClientCredentialError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} MCP client credentials.`;
  }
}

export class McpClientCredentials extends Context.Service<
  McpClientCredentials,
  {
    readonly issue: (input: {
      readonly label: string;
      readonly runtimeModeCeiling?: typeof RuntimeMode.Type;
    }) => Effect.Effect<
      { readonly token: string; readonly credential: Credential },
      McpClientCredentialError
    >;
    readonly list: Effect.Effect<ReadonlyArray<Credential>, McpClientCredentialError>;
    readonly revoke: (id: string) => Effect.Effect<boolean, McpClientCredentialError>;
    readonly resolve: (
      token: string,
    ) => Effect.Effect<Credential | undefined, McpClientCredentialError>;
  }
>()("t3/mcp/McpClientCredentials") {}

const publicCredential = ({ tokenHash: _hash, ...credential }: typeof StoredCredential.Type) =>
  credential;

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  // Like the per-entry server ledgers, independent files avoid a shared read/modify/write
  // race between the running server and CLI. Publish atomically; never cache reads so
  // revocation takes effect on the next HTTP request without a restart or DB migration.
  const directory = path.join(config.stateDir, "mcp-clients");
  const fileFor = (hash: string) => path.join(directory, `${hash}.json`);
  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("hex")));
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(decode),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
  const records = Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(directory)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
        ),
      );
    const entries = yield* Effect.forEach(
      names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)),
      (name) => read(path.join(directory, name)),
    );
    return entries.filter((entry) => entry !== undefined);
  });
  const issue = Effect.fn("McpClientCredentials.issue")(function* (input: {
    readonly label: string;
    readonly runtimeModeCeiling?: typeof RuntimeMode.Type;
  }) {
    if (!input.label.trim())
      return yield* Effect.fail(
        new McpClientCredentialError({ operation: "issue", cause: "Label cannot be blank." }),
      );
    const id = yield* crypto.randomUUIDv4;
    const token = Buffer.from(yield* crypto.randomBytes(32)).toString("base64url");
    const tokenHash = yield* hashToken(token);
    const credential = {
      id,
      label: input.label,
      runtimeModeCeiling: input.runtimeModeCeiling ?? "auto",
      issuedAt: yield* Clock.currentTimeMillis,
    };
    yield* fs.makeDirectory(directory, { recursive: true });
    const temporary = path.join(directory, `${id}.tmp`);
    yield* fs.writeFileString(temporary, yield* encode({ ...credential, tokenHash }), {
      mode: 0o600,
    });
    yield* fs
      .rename(temporary, fileFor(tokenHash))
      .pipe(Effect.onError(() => fs.remove(temporary, { force: true }).pipe(Effect.ignore)));
    return { token, credential };
  });
  return McpClientCredentials.of({
    issue: (input) =>
      issue(input).pipe(
        Effect.mapError((cause) => new McpClientCredentialError({ operation: "issue", cause })),
      ),
    list: records.pipe(
      Effect.map((entries) =>
        entries
          .map(publicCredential)
          .sort((a, b) => a.issuedAt - b.issuedAt || a.id.localeCompare(b.id)),
      ),
      Effect.mapError((cause) => new McpClientCredentialError({ operation: "list", cause })),
    ),
    resolve: Effect.fn("McpClientCredentials.resolve")(function* (token) {
      if (!token) return undefined;
      const tokenHash = yield* hashToken(token).pipe(
        Effect.mapError((cause) => new McpClientCredentialError({ operation: "resolve", cause })),
      );
      const entry = yield* read(fileFor(tokenHash)).pipe(
        Effect.mapError((cause) => new McpClientCredentialError({ operation: "resolve", cause })),
      );
      return entry?.tokenHash === tokenHash ? publicCredential(entry) : undefined;
    }),
    revoke: (id) =>
      Effect.gen(function* () {
        const entry = (yield* records).find((entry) => entry.id === id);
        if (!entry) return false;
        yield* fs.remove(fileFor(entry.tokenHash), { force: true });
        return true;
      }).pipe(
        Effect.mapError((cause) => new McpClientCredentialError({ operation: "revoke", cause })),
      ),
  });
});

export const layer = Layer.effect(McpClientCredentials, make);
