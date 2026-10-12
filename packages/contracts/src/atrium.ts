import * as Schema from "effect/Schema";

/** A bare UUIDv7, validated as authored rather than trimmed or URL-decoded. */
export const AtriumUid = Schema.String.check(
  Schema.isMaxLength(36),
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export type AtriumUid = typeof AtriumUid.Type;

export const AtriumReadObjectInput = Schema.Struct({ uid: AtriumUid });
export type AtriumReadObjectInput = typeof AtriumReadObjectInput.Type;

export const AtriumReadObjectResult = Schema.Struct({
  uid: AtriumUid,
  title: Schema.String,
  path: Schema.String,
  kind: Schema.NullOr(Schema.String),
  body: Schema.String,
});
export type AtriumReadObjectResult = typeof AtriumReadObjectResult.Type;

export class AtriumReadObjectError extends Schema.TaggedError<AtriumReadObjectError>()(
  "AtriumReadObjectError",
  {
    uid: Schema.String,
    reason: Schema.Literals(["not-found", "unavailable", "invalid-response"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-found":
        return `Atrium object ${this.uid} was not found.`;
      case "unavailable":
        return `Atrium Service is unavailable while reading object ${this.uid}.`;
      case "invalid-response":
        return `Atrium Service returned an invalid response for object ${this.uid}.`;
    }
  }
}
