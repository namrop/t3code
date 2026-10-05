import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ServerConfig from "./config.ts";

const MAX_SPEECH_CHARACTERS = 5_000;
const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function dropFencedCodeBlocks(markdown: string): string {
  const output: string[] = [];
  let fence: { character: "`" | "~"; length: number } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)
      )
        fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[0] as "`" | "~", length: marker.length };
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
}

function dropMarkdownTables(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (header?.includes("|") && separator && TABLE_SEPARATOR_ROW.test(separator)) {
      index += 2;
      while (index < lines.length && lines[index]?.includes("|")) index += 1;
      index -= 1;
      continue;
    }
    if (header !== undefined) output.push(header);
  }
  return output.join("\n");
}

/** Convert reply Markdown into prose, without reading code or tables aloud. */
export function prepareReplySpeechText(markdown: string): string {
  const plain = dropMarkdownTables(dropFencedCodeBlocks(markdown))
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,2}([^`]+)`{1,2}/g, "$1")
    .replace(/<\/?[^>\n]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\\([\\`*_{}[\]()#+.!|>-])/g, "$1")
    .replace(/[\\*~]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(plain).slice(0, MAX_SPEECH_CHARACTERS).join("");
}

export class ReplySpeechError extends Schema.TaggedError<ReplySpeechError>()("ReplySpeechError", {
  status: Schema.Number,
  detail: Schema.String,
}) {}

export class ReplySpeech extends Context.Service<
  ReplySpeech,
  {
    readonly synthesize: (text: string) => Effect.Effect<Uint8Array, ReplySpeechError>;
  }
>()("t3/replySpeech") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const synthesize = Effect.fn("ReplySpeech.synthesize")(function* (text: string) {
    if (config.speechUrl === undefined)
      return yield* new ReplySpeechError({
        status: 503,
        detail: "Reply speech is not configured.",
      });
    if (text.length > 100_000)
      return yield* new ReplySpeechError({
        status: 413,
        detail: "Reply text is too large to prepare for speech.",
      });
    const input = prepareReplySpeechText(text);
    if (!input)
      return yield* new ReplySpeechError({
        status: 400,
        detail: "No speakable text was found in this reply.",
      });
    const bytes = yield* httpClient
      .execute(
        HttpClientRequest.post(new URL("/v1/audio/speech", config.speechUrl).toString()).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            model: config.speechModel ?? ServerConfig.DEFAULT_SPEECH_MODEL,
            input,
            voice: config.speechVoice ?? ServerConfig.DEFAULT_SPEECH_VOICE,
            response_format: "mp3",
            speed: 1,
          }),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.arrayBuffer
            : Effect.succeed(null),
        ),
        Effect.scoped,
        Effect.mapError(
          () =>
            new ReplySpeechError({
              status: 502,
              detail: "The speech service failed to generate audio.",
            }),
        ),
      );
    if (bytes === null)
      return yield* new ReplySpeechError({
        status: 502,
        detail: "The speech service failed to generate audio.",
      });
    return new Uint8Array(bytes);
  });
  return ReplySpeech.of({ synthesize });
});
export const layer = Layer.effect(ReplySpeech, make);
