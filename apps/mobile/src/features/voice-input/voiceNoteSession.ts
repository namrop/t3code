// Same capability gate and ACP output-text shape as the web voice-note path.
export function providerTakesVoiceNotes(
  provider: { readonly supportsAudioPrompts?: boolean } | null | undefined,
): boolean {
  return provider?.supportsAudioPrompts === true;
}
function outputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(outputText).filter(Boolean).join("\n") || null;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return typeof object.text === "string" ? object.text : outputText(object.content);
  }
  return null;
}
export function voiceNoteTranscript(item: {
  readonly type: string;
  readonly status: string;
  readonly toolName?: string | null;
  readonly output?: unknown;
}): string | null {
  if (
    item.type !== "dynamic_tool" ||
    item.status !== "completed" ||
    item.toolName !== "voice_note_transcript"
  )
    return null;
  const text = outputText(item.output);
  return text?.trim() ? text : null;
}
export type VoiceNotePhase = "idle" | "preparing" | "recording" | "finishing" | "error";
type Dependencies = {
  requestPermission: () => Promise<boolean>;
  prepare: () => Promise<void>;
  record: () => void;
  stop: () => Promise<string | null>;
  release: () => Promise<void>;
  deleteRecording: (uri: string) => Promise<void>;
  onChange: (phase: VoiceNotePhase, error: string | null) => void;
};
/** Captures bytes, never dictation. The composer/outbox owns upload and delivery. */
export class VoiceNoteSession {
  phase: VoiceNotePhase = "idle";
  private generation = 0;
  private preparing: Promise<void> | null = null;
  private requestingPermission = false;
  // Android's permission activity pauses our activity, even for an existing
  // grant. That pause is not an abandoned recording. Unmount still cancels.
  async onAppBackground(): Promise<void> {
    if (!this.requestingPermission) await this.cancel();
  }
  constructor(private readonly dependencies: Dependencies) {}
  private update(phase: VoiceNotePhase, error: string | null = null) {
    this.phase = phase;
    this.dependencies.onChange(phase, error);
  }
  async start(): Promise<void> {
    if (this.phase !== "idle" && this.phase !== "error") return;
    const generation = ++this.generation;
    this.update("preparing");
    try {
      this.requestingPermission = true;
      let granted: boolean;
      try {
        granted = await this.dependencies.requestPermission();
      } finally {
        this.requestingPermission = false;
      }
      if (generation !== this.generation) return;
      if (!granted) {
        this.update("error", "Allow microphone access in Android app settings.");
        return;
      }
      this.preparing = this.dependencies.prepare();
      await this.preparing;
      if (generation !== this.generation) return;
      this.dependencies.record();
      this.update("recording");
    } catch (error) {
      if (generation === this.generation) {
        await this.dependencies.release();
        this.update(
          "error",
          error instanceof Error ? error.message : "Could not record a voice note.",
        );
      }
    } finally {
      this.preparing = null;
    }
  }
  async finish(): Promise<string | null> {
    if (this.phase !== "recording") return null;
    this.update("finishing");
    try {
      const uri = await this.dependencies.stop();
      if (!uri) throw new Error("Nothing was recorded.");
      return uri;
    } finally {
      await this.dependencies.release();
      this.update("idle");
    }
  }
  async cancel(): Promise<void> {
    const phase = this.phase;
    ++this.generation;
    this.update("idle");
    if (phase === "recording" || this.preparing) {
      try {
        await this.preparing?.catch(() => {});
        const uri = await this.dependencies.stop();
        if (uri) await this.dependencies.deleteRecording(uri);
      } finally {
        await this.dependencies.release();
      }
    }
  }
}
