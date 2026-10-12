import {
  AtriumReadObjectError,
  AtriumUid,
  type AtriumReadObjectInput,
  type AtriumReadObjectResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";

const AtriumObjectResponse = Schema.Struct({
  ok: Schema.Literal(true),
  object: Schema.Struct({
    uid: AtriumUid,
    path: Schema.String,
    body: Schema.String,
    frontmatter: Schema.Struct({ title: Schema.String }),
    kind: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const decodeResponse = HttpClientResponse.schemaBodyJson(AtriumObjectResponse);

export class AtriumObjectReader extends Context.Service<
  AtriumObjectReader,
  {
    readonly readObject: (
      input: AtriumReadObjectInput,
    ) => Effect.Effect<AtriumReadObjectResult, AtriumReadObjectError>;
  }
>()("t3/atrium/AtriumObjectReader") {}

const make = Effect.gen(function* () {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);

  const readObject: AtriumObjectReader["Service"]["readObject"] = Effect.fn(
    "AtriumObjectReader.readObject",
  )(
    function* ({ uid }) {
      const response = yield* httpClient
        .get("https://atrium.sol.pharos.zone/api/object", { urlParams: { ref: uid } })
        .pipe(
          Effect.mapError(
            (cause) => new AtriumReadObjectError({ uid, reason: "unavailable", cause }),
          ),
        );
      if (response.status === 404) {
        return yield* new AtriumReadObjectError({ uid, reason: "not-found" });
      }
      yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.mapError(
          (cause) => new AtriumReadObjectError({ uid, reason: "unavailable", cause }),
        ),
      );
      const { object } = yield* decodeResponse(response).pipe(
        Effect.mapError(
          (cause) => new AtriumReadObjectError({ uid, reason: "invalid-response", cause }),
        ),
      );
      if (object.uid !== uid) {
        return yield* new AtriumReadObjectError({
          uid,
          reason: "invalid-response",
          cause: new Error("Atrium response UID does not match the requested UID."),
        });
      }
      return {
        uid: object.uid,
        title: object.frontmatter.title,
        path: object.path,
        kind: object.kind ?? null,
        body: object.body,
      };
    },
    (effect, { uid }) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeout("30 seconds"),
        Effect.catchTag(
          "TimeoutError",
          (cause) => new AtriumReadObjectError({ uid, reason: "unavailable", cause }),
        ),
      ),
  );

  return AtriumObjectReader.of({ readObject });
});

export const layer = Layer.effect(AtriumObjectReader, make);
