import type { RunId } from "@t3tools/contracts";

interface TranscriptEntry {
  readonly kind: string;
  readonly entry?: {
    readonly structuredPayload?: {
      readonly type: string;
      readonly runId: RunId | null;
      readonly toolName?: string | null | undefined;
      readonly status: string;
      readonly output?: unknown;
    };
  };
}
function outputText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join("\n") || undefined;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (typeof object.text === "string") return object.text;
    return outputText(object.content);
  }
  return undefined;
}
/** Bind complete transcript tool output to the recording's turn, not the next message. */
export function voiceNoteTranscriptsByRun(
  entries: ReadonlyArray<TranscriptEntry>,
): ReadonlyMap<RunId, ReadonlyArray<string>> {
  const byRun = new Map<RunId, string[]>();
  for (const entry of entries) {
    const item = entry.kind === "work" ? entry.entry?.structuredPayload : undefined;
    if (
      !item ||
      item.type !== "dynamic_tool" ||
      item.status !== "completed" ||
      item.toolName !== "voice_note_transcript" ||
      item.runId === null
    )
      continue;
    const text = outputText(item.output);
    if (!text?.trim()) continue;
    const transcripts = byRun.get(item.runId) ?? [];
    if (!transcripts.includes(text)) transcripts.push(text);
    byRun.set(item.runId, transcripts);
  }
  return byRun;
}
