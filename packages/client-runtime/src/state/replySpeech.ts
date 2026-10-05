import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { PreparedConnection } from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export class ReplySpeechRequestError extends Data.TaggedError("ReplySpeechRequestError")<{
  readonly message: string;
}> {}

/** Speech uses the reply's environment and its cookie, bearer, or refreshed DPoP credential. */
export const fetchEnvironmentReplySpeech = Effect.fn("clientRuntime.fetchEnvironmentReplySpeech")(
  function* (prepared: PreparedConnection, text: string) {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    let requestUrl = new URL("/api/reply-speech", prepared.httpBaseUrl).toString();
    const result = yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "auth",
      method: "POST",
      timeoutMs: 60_000,
      url: (httpBaseUrl) => {
        // The authorization helper may refresh a relay endpoint along with its credential.
        requestUrl = new URL("/api/reply-speech", httpBaseUrl).toString();
        return requestUrl;
      },
      request: ({ headers }) =>
        Effect.gen(function* () {
          const response = yield* httpClient.execute(
            HttpClientRequest.post(requestUrl).pipe(
              HttpClientRequest.setHeaders({ ...headers }),
              HttpClientRequest.bodyJsonUnsafe({ text }),
            ),
          );
          return response.status >= 200 && response.status < 300
            ? { status: response.status, bytes: yield* response.arrayBuffer, detail: "" }
            : { status: response.status, bytes: null, detail: yield* response.text };
        }),
      isUnauthorizedResponse: (response) => response.status === 401,
    });
    if (result.bytes === null) {
      return yield* new ReplySpeechRequestError({
        message: result.detail.trim() || `Speech request failed (HTTP ${result.status}).`,
      });
    }
    return new Uint8Array(result.bytes);
  },
);
