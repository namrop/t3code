import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import * as Contracts from "./index.ts";

const decodeInput = Schema.decodeSync(Contracts.AtriumReadObjectInput);
const decodeResult = Schema.decodeUnknownSync(Contracts.AtriumReadObjectResult);
const encodeError = Schema.encodeSync(Contracts.AtriumReadObjectError);
const decodeError = Schema.decodeUnknownSync(Contracts.AtriumReadObjectError);
const rpc = Contracts.WsRpcGroup.requests.get(Contracts.WS_METHODS.atriumReadObject);
if (!rpc) throw new Error("atrium.readObject is not registered");
const decodeRpcInput = Schema.decodeSync(rpc.payloadSchema);
const decodeRpcResult = Schema.decodeSync(rpc.successSchema);
const encodeRpcError = Schema.encodeSync(rpc.errorSchema);
const decodeRpcError = Schema.decodeSync(rpc.errorSchema);

const UID = "01900000-0000-7000-8000-000000000001";
const object = {
  uid: UID,
  title: "Example object",
  path: "01_example/example.md",
  kind: "note",
  body: "# Example\n\nLiteral body.\n",
};

describe("Atrium object contracts", () => {
  it("accepts a literal UUIDv7 without transforming it", () => {
    expect(Contracts.AtriumReadObjectInput).toBeDefined();
    expect(decodeInput({ uid: UID })).toEqual({ uid: UID });
    const uppercase = "01900000-0000-7ABC-8DEF-000000000001";
    expect(decodeInput({ uid: uppercase })).toEqual({ uid: uppercase });
  });

  it.each([
    ` ${UID}`,
    `${UID} `,
    `${UID}\n`,
    `atrium://uid/${UID}`,
    `uid:${UID}`,
    `${UID}?rel=example`,
    "01900000-0000-4000-8000-000000000001",
    "01900000-0000-7000-0000-000000000001",
    "%30" + UID.slice(1),
    "01_example/example.md",
    "",
  ])("rejects a malformed or non-UUIDv7 UID: %j", (uid) => {
    expect(Contracts.AtriumReadObjectInput).toBeDefined();
    expect(() => decodeInput({ uid })).toThrow();
  });

  it("preserves the body and accepts a nullable kind", () => {
    expect(Contracts.AtriumReadObjectResult).toBeDefined();
    expect(decodeResult(object)).toEqual(object);
    expect(decodeResult({ ...object, kind: null, body: "" })).toEqual({
      ...object,
      kind: null,
      body: "",
    });
    expect(() => decodeResult({ ...object, body: undefined })).toThrow();
    expect(() => decodeResult({ ...object, uid: "invalid" })).toThrow();
  });

  it.each(["not-found", "unavailable", "invalid-response"] as const)(
    "round-trips the typed %s error through its wire schema",
    (reason) => {
      expect(Contracts.AtriumReadObjectError).toBeDefined();
      const error = new Contracts.AtriumReadObjectError({ uid: UID, reason });
      const encoded = encodeError(error);
      const decoded = decodeError(encoded);
      expect(decoded).toMatchObject({ _tag: "AtriumReadObjectError", uid: UID, reason });
      expect(decoded.message).toContain(UID);
      expect(() => decodeError({ ...encoded, reason: "other" })).toThrow();
    },
  );

  it("registers the payload, result, and error on the WebSocket RPC group", () => {
    expect(Contracts.WS_METHODS.atriumReadObject).toBe("atrium.readObject");
    expect(rpc).toBeDefined();
    expect(decodeRpcInput({ uid: UID })).toEqual({ uid: UID });
    expect(() => decodeRpcInput({ uid: ` ${UID}` })).toThrow();
    expect(decodeRpcResult(object)).toEqual(object);
    const error = new Contracts.AtriumReadObjectError({ uid: UID, reason: "not-found" });
    expect(decodeRpcError(encodeRpcError(error))).toMatchObject({
      _tag: "AtriumReadObjectError",
      uid: UID,
      reason: "not-found",
    });
  });
});
