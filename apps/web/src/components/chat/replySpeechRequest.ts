import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary/target";
import { runPrimaryRawHttp } from "~/lib/runtime";

class ReplySpeechHttpError extends Data.TaggedError("ReplySpeechHttpError")<{
  readonly message: string;
}> {}

export async function requestReplySpeechAudio(text: string, signal: AbortSignal): Promise<Blob> {
  return runPrimaryRawHttp(
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const response = yield* httpClient.execute(
        HttpClientRequest.post(resolvePrimaryEnvironmentHttpUrl("/api/reply-speech")).pipe(
          HttpClientRequest.bodyJsonUnsafe({ text }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
        return yield* Effect.fail(
          new ReplySpeechHttpError({
            message: detail.trim() || `Speech request failed (HTTP ${response.status}).`,
          }),
        );
      }
      const bytes = yield* response.arrayBuffer;
      return new Blob([bytes], { type: "audio/mpeg" });
    }).pipe(Effect.scoped),
    signal,
  );
}
