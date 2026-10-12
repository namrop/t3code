import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as Reader from "./AtriumObjectReader.ts";

const UID = "01900000-0000-7000-8000-000000000001";
const object = {
  uid: UID,
  path: "01_example/example.md",
  body: "# Example\n\nLiteral body.\n",
  frontmatter: { title: "Example object" },
  kind: "note",
};

const readObject = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const reader = yield* Reader.AtriumObjectReader;
    return yield* reader.readObject({ uid: UID });
  }).pipe(
    Effect.provide(Reader.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)))),
  );

const responseClient = (payload: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(payload, { status }))),
  );

const expectReadError = (client: HttpClient.HttpClient, reason: string, withCause = true) =>
  Effect.gen(function* () {
    const error = yield* readObject(client).pipe(Effect.flip);
    expect(error).toMatchObject({ _tag: "AtriumReadObjectError", uid: UID, reason });
    expect(error.message).toContain(UID);
    if (withCause) expect(error.cause).toBeDefined();
  });

describe("AtriumObjectReader", () => {
  it.effect("reads the requested UID from Atrium Service and projects the object", () => {
    const requests: Array<{ method: string; url: string }> = [];
    const client = HttpClient.make((request, url) =>
      Effect.sync(() => {
        requests.push({ method: request.method, url: url.toString() });
        return HttpClientResponse.fromWeb(request, Response.json({ ok: true, object }));
      }),
    );
    return Effect.gen(function* () {
      expect(yield* readObject(client)).toEqual({
        uid: UID,
        title: "Example object",
        path: "01_example/example.md",
        kind: "note",
        body: object.body,
      });
      expect(requests).toEqual([
        { method: "GET", url: `https://atrium.sol.pharos.zone/api/object?ref=${UID}` },
      ]);
    });
  });

  it.effect("keeps an empty body valid and projects an absent kind as null", () =>
    Effect.gen(function* () {
      const { kind: _kind, ...withoutKind } = object;
      const result = yield* readObject(
        responseClient({ ok: true, object: { ...withoutKind, body: "" } }),
      );
      expect(result.body).toBe("");
      expect(result.kind).toBeNull();
    }),
  );

  it.effect("preserves a null kind", () =>
    Effect.gen(function* () {
      const result = yield* readObject(
        responseClient({ ok: true, object: { ...object, kind: null } }),
      );
      expect(result.kind).toBeNull();
    }),
  );

  it.effect("distinguishes HTTP 404 even when its body is not JSON", () =>
    expectReadError(
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("Not found", { status: 404 })),
        ),
      ),
      "not-found",
      false,
    ),
  );

  it.effect.each([301, 401, 500, 503])(
    "reports HTTP %s as unavailable even with a success-shaped body",
    (status) => expectReadError(responseClient({ ok: true, object }, status), "unavailable"),
  );

  it.effect("wraps a network failure as unavailable", () =>
    expectReadError(
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: new Error("Connection refused"),
            }),
          }),
        ),
      ),
      "unavailable",
    ),
  );

  it.effect("rejects invalid JSON", () =>
    expectReadError(
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("not JSON"))),
      ),
      "invalid-response",
    ),
  );

  it.effect.each([
    ["an unsuccessful envelope", { ok: false, object }],
    ["a missing object", { ok: true }],
    ["a missing body", { ok: true, object: { ...object, body: undefined } }],
    ["a null body", { ok: true, object: { ...object, body: null } }],
    ["a non-string body", { ok: true, object: { ...object, body: 42 } }],
    ["a missing path", { ok: true, object: { ...object, path: undefined } }],
    ["a missing title", { ok: true, object: { ...object, frontmatter: {} } }],
    ["a malformed UID", { ok: true, object: { ...object, uid: "invalid" } }],
    [
      "a different object's UID",
      { ok: true, object: { ...object, uid: "01900000-0000-7000-8000-000000000002" } },
    ],
  ] as const)("rejects %s", ([_name, payload]) =>
    expectReadError(responseClient(payload), "invalid-response"),
  );

  it.effect("reads the current service projection on each request without a path cache", () => {
    let requestCount = 0;
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requestCount += 1;
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            ok: true,
            object: { ...object, path: requestCount === 1 ? object.path : "02_example/moved.md" },
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const reader = yield* Reader.AtriumObjectReader;
      expect((yield* reader.readObject({ uid: UID })).path).toBe(object.path);
      expect((yield* reader.readObject({ uid: UID })).path).toBe("02_example/moved.md");
      expect(requestCount).toBe(2);
    }).pipe(
      Effect.provide(
        Reader.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    );
  });

  it.effect.each(["request", "body"] as const)(
    "bounds a stalled %s with a typed unavailable error and interrupts it",
    (stage) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const stalled = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
        const client = HttpClient.make((request) => {
          const response = HttpClientResponse.fromWeb(request, Response.json({ ok: true, object }));
          return stage === "request"
            ? stalled
            : Effect.succeed(Object.defineProperty(response, "json", { value: stalled }));
        });
        const fiber = yield* readObject(client).pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("30 seconds");
        expect(fiber.pollUnsafe()).toBeDefined();
        const error = yield* Fiber.join(fiber);
        expect(error).toMatchObject({
          _tag: "AtriumReadObjectError",
          uid: UID,
          reason: "unavailable",
        });
        expect(error.cause).toMatchObject({ _tag: "TimeoutError" });
        yield* Deferred.await(interrupted);
      }),
  );
});
