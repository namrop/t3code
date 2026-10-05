import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, FetchHttpClient } from "effect/http";
import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { fetchEnvironmentReplySpeech } from "./replySpeech.ts";

const target = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("speech-env"),
  label: "Speech",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: "https://voice-env.test",
  socketUrl: "wss://voice-env.test/ws",
  httpAuthorization: null,
};

function clientFixture(statuses = [200]) {
  const requests: {
    url: string;
    headers: Readonly<Record<string, string>>;
    credentials?: string;
  }[] = [];
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      requests.push({
        url: request.url,
        headers: request.headers,
        ...(init._tag === "Some" ? { credentials: init.value.credentials } : {}),
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(new Uint8Array([1, 2, 3]), {
          status: statuses.shift() ?? 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      );
    }),
  );
  return { requests, client };
}

describe("environment reply speech", () => {
  it.effect("uses the selected environment and includes its session cookie", () =>
    Effect.gen(function* () {
      const fixture = clientFixture();
      const bytes = yield* fetchEnvironmentReplySpeech(prepared, "Hello").pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.client),
        Effect.scoped,
      );
      expect([...bytes]).toEqual([1, 2, 3]);
      expect(fixture.requests[0]?.url).toBe("https://voice-env.test/api/reply-speech");
      expect(fixture.requests[0]?.credentials).toBe("include");
    }),
  );
  it.effect("carries the selected environment's bearer credential", () =>
    Effect.gen(function* () {
      const fixture = clientFixture();
      yield* fetchEnvironmentReplySpeech(
        { ...prepared, httpAuthorization: { _tag: "Bearer", token: "test-token" } },
        "Hello",
      ).pipe(Effect.provideService(HttpClient.HttpClient, fixture.client), Effect.scoped);
      expect(fixture.requests[0]?.headers.authorization).toBe("Bearer test-token");
    }),
  );
  it.effect("refreshes a rejected relay credential and signs each actual speech URL", () =>
    Effect.gen(function* () {
      const fixture = clientFixture([401, 200]);
      const proofs: { url: string; method: string; accessToken?: string }[] = [];
      const signer = {
        createProof: (input: (typeof proofs)[number]) => {
          proofs.push(input);
          return Effect.succeed("test-proof");
        },
      } as unknown as ManagedRelayDpopSigner["Service"];
      const remote = {
        authorizeDpopHttp: (input: { rejectedAccessToken?: string }) =>
          Effect.succeed({
            environmentId: prepared.environmentId,
            label: "Speech",
            httpBaseUrl: input.rejectedAccessToken
              ? "https://renewed-env.test"
              : "https://current-env.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: input.rejectedAccessToken ? "renewed-token" : "current-token",
              expiresAtEpochMs: 9999999999999,
            },
          }),
      } as unknown as RemoteEnvironmentAuthorization["Service"];
      yield* fetchEnvironmentReplySpeech(
        {
          ...prepared,
          httpAuthorization: { _tag: "Dpop", accessToken: "expired-token", expiresAtEpochMs: 0 },
        },
        "Hello",
      ).pipe(
        Effect.provideService(HttpClient.HttpClient, fixture.client),
        Effect.provideService(ManagedRelayDpopSigner, signer),
        Effect.provideService(RemoteEnvironmentAuthorization, remote),
        Effect.scoped,
      );
      expect(fixture.requests.map((r) => r.url)).toEqual([
        "https://current-env.test/api/reply-speech",
        "https://renewed-env.test/api/reply-speech",
      ]);
      expect(fixture.requests.map((r) => r.headers.authorization)).toEqual([
        "DPoP current-token",
        "DPoP renewed-token",
      ]);
      expect(proofs.map((p) => [p.method, p.url])).toEqual([
        ["POST", "https://current-env.test/api/reply-speech"],
        ["POST", "https://renewed-env.test/api/reply-speech"],
      ]);
    }),
  );
});
