import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerConfig from "./config.ts";
import { replySpeechRouteLayer } from "./http.ts";
import { prepareReplySpeechText } from "./replySpeech.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function speechRouteFixture(input: {
  readonly speechUrl?: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly gatewayStatus?: number;
}) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const audio = new Uint8Array([1, 2, 3, 4]);
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({ url: request.url, body: request.body });
      return HttpClientResponse.fromWeb(
        request,
        new Response(audio, {
          status: input.gatewayStatus ?? 200,
          headers: { "content-type": "audio/mpeg" },
        }),
      );
    }),
  );
  const config = {
    speechUrl: input.speechUrl === undefined ? undefined : new URL(input.speechUrl),
    speechModel: "test-model",
    speechVoice: "test-voice",
  } as unknown as ServerConfig.ServerConfig["Service"];
  const auth = {
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("speech-test"),
        subject: "test",
        method: "bearer-access-token",
        scopes: input.scopes ?? [AuthOrchestrationReadScope],
      }),
  } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
  const { handler, dispose } = HttpRouter.toWebHandler(
    replySpeechRouteLayer.pipe(
      Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provideMerge(Layer.succeed(ServerConfig.ServerConfig, config)),
      Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, client)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, requests, audio };
}

const postReply = (text: string) =>
  new Request("http://t3.test/api/reply-speech", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });

describe("prepareReplySpeechText", () => {
  it("keeps prose and link labels while dropping fenced code and tables", () => {
    expect(
      prepareReplySpeechText(
        "## Result\n\nSee [the report](https://example.com/report).\n\n```ts\nconst secret = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |\n\nDone.",
      ),
    ).toBe("Result See the report. Done.");
  });

  it("removes inline Markdown syntax but keeps its words", () => {
    expect(prepareReplySpeechText("**Ready**: `run build` and ~~old~~ _new_.")).toBe(
      "Ready: run build and old new.",
    );
    expect(prepareReplySpeechText("Set `voice_note_transcript` in _hermes_tool_name_.")).toBe(
      "Set voice note transcript in hermes tool name.",
    );
  });

  it("caps speakable output at 5000 Unicode characters without splitting a surrogate pair", () => {
    const prepared = prepareReplySpeechText("🙂".repeat(5_001));

    expect(Array.from(prepared)).toHaveLength(5_000);
    expect(prepared.endsWith("🙂")).toBe(true);
  });

  it("returns empty text when a reply contains only fenced code", () => {
    expect(prepareReplySpeechText("```js\nconsole.log('not spoken')\n```\n")).toBe("");
  });
});

describe("reply speech route", () => {
  it("requires an authenticated read session before generating speech", async () => {
    const { handler, requests } = speechRouteFixture({
      speechUrl: "https://speech.test",
      scopes: [],
    });

    const response = await handler(postReply("Hello"));

    expect(response.status).toBe(403);
    expect(requests).toHaveLength(0);
  });

  it("prepares Markdown, calls the speech gateway, and returns audio bytes", async () => {
    const { handler, requests, audio } = speechRouteFixture({
      speechUrl: "https://speech.test",
    });

    const response = await handler(postReply("Hello **world**"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://speech.test/v1/audio/speech");
    const requestBody = requests[0]?.body as { readonly body?: string };
    expect(JSON.parse(requestBody.body ?? "")).toEqual({
      model: "test-model",
      input: "Hello world",
      voice: "test-voice",
      response_format: "mp3",
      speed: 1,
    });
  });

  it("returns clear errors when speech is disabled, input is empty, or the gateway fails", async () => {
    const disabled = speechRouteFixture({});
    const disabledResponse = await disabled.handler(postReply("Hello"));
    expect(disabledResponse.status).toBe(503);
    expect(await disabledResponse.text()).toContain("not configured");
    expect(disabled.requests).toHaveLength(0);

    const empty = speechRouteFixture({ speechUrl: "https://speech.test" });
    const emptyResponse = await empty.handler(postReply("```ts\nconst x = 1;\n```"));
    expect(emptyResponse.status).toBe(400);
    expect(await emptyResponse.text()).toContain("No speakable text");
    expect(empty.requests).toHaveLength(0);

    const failed = speechRouteFixture({ speechUrl: "https://speech.test", gatewayStatus: 503 });
    const failedResponse = await failed.handler(postReply("Hello"));
    expect(failedResponse.status).toBe(502);
    expect(await failedResponse.text()).toContain("speech service");
  });
});
