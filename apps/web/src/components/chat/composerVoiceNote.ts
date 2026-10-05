/**
 * One-tap voice notes for the web composer: record from the microphone, then
 * send the recording as a file attachment in one tap.
 *
 * The bar's layout and states follow the phone app's dictation toolbar
 * (`apps/mobile/src/features/voice-input/`): cancel, a live waveform with the
 * elapsed time, and a primary action. Dictation there turns speech into draft
 * text; here the recording itself is sent, and the provider transcribes it
 * (Hermes does, as it does gateway voice notes).
 */

/** Long enough for a spoken brief; Opus at 32 kbit/s stays near 4 MB. */
export const VOICE_NOTE_LIMIT_SECONDS = 15 * 60;
/** Speech-quality Opus. Browsers default to ~128 kbit/s for audio-only. */
export const VOICE_NOTE_BITS_PER_SECOND = 32_000;
/** Same sample count and cadence as the phone app's dictation waveform. */
export const VOICE_NOTE_WAVEFORM_SAMPLE_COUNT = 64;
export const VOICE_NOTE_METERING_INTERVAL_MS = 80;
/** MediaRecorder hands over data each second, so a crash loses at most that. */
const VOICE_NOTE_TIMESLICE_MS = 1_000;

const VOICE_NOTE_RECORDER_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

const VOICE_NOTE_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

/** Audio is negotiated by the provider, never inferred from its name. */
export function providerTakesVoiceNotes(
  provider: { readonly supportsAudioPrompts?: boolean } | null | undefined,
): boolean {
  return provider?.supportsAudioPrompts === true;
}

export type VoiceNotePhase = "idle" | "preparing" | "recording" | "sending" | "error";

export type VoiceNoteState = {
  readonly phase: VoiceNotePhase;
  readonly error: string | null;
  readonly elapsedSeconds: number;
  readonly levels: readonly number[];
};

const SILENT_LEVELS: readonly number[] = Object.freeze(
  Array.from({ length: VOICE_NOTE_WAVEFORM_SAMPLE_COUNT }, () => 0),
);

export const VOICE_NOTE_IDLE_STATE: VoiceNoteState = Object.freeze({
  phase: "idle",
  error: null,
  elapsedSeconds: 0,
  levels: SILENT_LEVELS,
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function pickVoiceNoteRecorderMimeType(
  isTypeSupported: (type: string) => boolean,
): string | undefined {
  return VOICE_NOTE_RECORDER_MIME_TYPES.find((type) => isTypeSupported(type));
}

/** The file's type and extension, from what the recorder actually produced. */
export function voiceNoteFileType(recordedMimeType: string): {
  readonly mimeType: string;
  readonly extension: string;
} {
  const base = recordedMimeType.split(";", 1)[0]!.trim().toLowerCase();
  const extension = VOICE_NOTE_EXTENSIONS[base];
  return extension ? { mimeType: base, extension } : { mimeType: "audio/webm", extension: "webm" };
}

export function voiceNoteFileName(startedAt: Date, extension: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
  const time = `${pad(startedAt.getHours())}.${pad(startedAt.getMinutes())}.${pad(startedAt.getSeconds())}`;
  return `Voice note ${date} ${time}.${extension}`;
}

const NOISE_FLOOR_DECIBELS = -60;
const NOISE_FLOOR_AMPLITUDE = 10 ** (NOISE_FLOOR_DECIBELS / 20);

/**
 * Compressed 0..1 amplitude for the waveform, reserving full height for 0 dB.
 * Same curve as the phone app (`voiceInputMetering.ts`).
 */
export function normalizeVoiceNoteDecibels(decibels: number | undefined): number {
  if (decibels === undefined || !Number.isFinite(decibels)) return 0;
  if (decibels <= NOISE_FLOOR_DECIBELS) return 0;
  if (decibels >= 0) return 1;
  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - NOISE_FLOOR_AMPLITUDE) / (1 - NOISE_FLOOR_AMPLITUDE));
}

export function rmsToDecibels(samples: Float32Array): number {
  if (samples.length === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

export function formatVoiceNoteElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function isVoiceNoteRecordingAvailable(scope: {
  readonly navigator?: { readonly mediaDevices?: { readonly getUserMedia?: unknown } };
  readonly MediaRecorder?: unknown;
}): boolean {
  return (
    typeof scope.navigator?.mediaDevices?.getUserMedia === "function" &&
    typeof scope.MediaRecorder === "function"
  );
}

export function voiceNoteErrorMessage(error: unknown): string {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : null;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow it for this site in your browser settings.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is in use by another app.";
    default:
      return "Could not start recording.";
  }
}

/** How long the voice bar waits for the recording's upload before handing the draft back. */
export const VOICE_NOTE_HANDOFF_TIMEOUT_MS = 120_000;

export type VoiceNoteHandoffStep = "wait" | "send" | "release";

/**
 * What to do with a finished recording the composer has taken. The composer
 * refuses to send while an attachment is still uploading ("Attachment still
 * uploading"), so a send attempted the moment the file lands is silently
 * dropped. Wait for the upload; send when it is ready; otherwise hand the
 * draft back so the composer shows the failed chip or why sending is blocked.
 */
export function voiceNoteHandoffStep(input: {
  /** The recording is in the draft's files. */
  readonly landed: boolean;
  /** The server takes attachments by upload rather than inline. */
  readonly uploadsToServer: boolean;
  /** This recording's upload, for the composer's environment; null before it starts. */
  readonly uploadStatus: "uploading" | "ready" | "failed" | null;
  /** The composer's send is blocked for any reason. */
  readonly sendBlocked: boolean;
}): VoiceNoteHandoffStep {
  if (!input.landed) return "wait";
  if (input.uploadStatus === "failed") return "release";
  if (input.uploadsToServer && input.uploadStatus !== "ready") return "wait";
  return input.sendBlocked ? "release" : "send";
}

export type VoiceNotePresentation = {
  readonly showsBar: boolean;
  readonly showsCancel: boolean;
  readonly statusKind: "waveform" | "label" | "error" | null;
  readonly statusLabel: string | null;
  readonly sendEnabled: boolean;
  readonly sendLoading: boolean;
};

export function resolveVoiceNotePresentation(state: VoiceNoteState): VoiceNotePresentation {
  switch (state.phase) {
    case "idle":
      return {
        showsBar: false,
        showsCancel: false,
        statusKind: null,
        statusLabel: null,
        sendEnabled: false,
        sendLoading: false,
      };
    case "preparing":
      return {
        showsBar: true,
        showsCancel: true,
        statusKind: "label",
        statusLabel: "Preparing",
        sendEnabled: false,
        sendLoading: true,
      };
    case "recording":
      return {
        showsBar: true,
        showsCancel: true,
        statusKind: "waveform",
        statusLabel: `Recording ${formatVoiceNoteElapsed(state.elapsedSeconds)}`,
        sendEnabled: true,
        sendLoading: false,
      };
    case "sending":
      return {
        showsBar: true,
        showsCancel: false,
        statusKind: "label",
        statusLabel: "Sending",
        sendEnabled: false,
        sendLoading: true,
      };
    case "error":
      return {
        showsBar: true,
        showsCancel: false,
        statusKind: "error",
        statusLabel: state.error,
        sendEnabled: false,
        sendLoading: false,
      };
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** The slice of `MediaRecorder` the voice note uses. */
export interface VoiceNoteMediaRecorder {
  readonly state: "inactive" | "recording" | "paused";
  readonly mimeType: string;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface VoiceNoteLevelMeter {
  /** Current input level in dBFS. */
  readDecibels(): number;
  close(): void;
}

export interface VoiceNoteRecorderDependencies {
  readonly getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  readonly createMediaRecorder: (
    stream: MediaStream,
    options: { readonly mimeType?: string; readonly audioBitsPerSecond: number },
  ) => VoiceNoteMediaRecorder;
  readonly isTypeSupported: (type: string) => boolean;
  readonly createLevelMeter: (stream: MediaStream) => VoiceNoteLevelMeter | null;
  readonly now: () => number;
  readonly onChange: (state: VoiceNoteState) => void;
  /** Called once when a recording reaches {@link VOICE_NOTE_LIMIT_SECONDS}. */
  readonly onLimitReached: () => void;
}

type ActiveRecording = {
  readonly stream: MediaStream;
  readonly recorder: VoiceNoteMediaRecorder;
  readonly meter: VoiceNoteLevelMeter | null;
  readonly chunks: Blob[];
  readonly startedAt: number;
  readonly interval: ReturnType<typeof setInterval>;
  limitReported: boolean;
};

function releaseStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export class VoiceNoteRecorder {
  private readonly dependencies: VoiceNoteRecorderDependencies;
  private state: VoiceNoteState = VOICE_NOTE_IDLE_STATE;
  private session = 0;
  private active: ActiveRecording | null = null;

  constructor(dependencies: VoiceNoteRecorderDependencies) {
    this.dependencies = dependencies;
  }

  get currentState(): VoiceNoteState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state.phase !== "idle" && this.state.phase !== "error") return;
    const session = ++this.session;
    this.setState({ ...VOICE_NOTE_IDLE_STATE, phase: "preparing" });

    let stream: MediaStream;
    try {
      stream = await this.dependencies.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      if (session === this.session) {
        this.setState({
          ...VOICE_NOTE_IDLE_STATE,
          phase: "error",
          error: voiceNoteErrorMessage(error),
        });
      }
      return;
    }
    if (session !== this.session) {
      // Cancelled while the browser was asking for the microphone.
      releaseStream(stream);
      return;
    }

    let recorder: VoiceNoteMediaRecorder;
    try {
      const mimeType = pickVoiceNoteRecorderMimeType(this.dependencies.isTypeSupported);
      recorder = this.dependencies.createMediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: VOICE_NOTE_BITS_PER_SECOND,
      });
    } catch (error) {
      releaseStream(stream);
      this.setState({
        ...VOICE_NOTE_IDLE_STATE,
        phase: "error",
        error: voiceNoteErrorMessage(error),
      });
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = () => {
      if (session !== this.session) return;
      this.teardown({ stopRecorder: true });
      this.setState({
        ...VOICE_NOTE_IDLE_STATE,
        phase: "error",
        error: "Recording stopped unexpectedly.",
      });
    };

    let meter: VoiceNoteLevelMeter | null = null;
    try {
      meter = this.dependencies.createLevelMeter(stream);
    } catch {
      meter = null;
    }

    try {
      recorder.start(VOICE_NOTE_TIMESLICE_MS);
    } catch (error) {
      meter?.close();
      releaseStream(stream);
      this.setState({
        ...VOICE_NOTE_IDLE_STATE,
        phase: "error",
        error: voiceNoteErrorMessage(error),
      });
      return;
    }

    const startedAt = this.dependencies.now();
    const interval = setInterval(() => this.sample(session), VOICE_NOTE_METERING_INTERVAL_MS);
    this.active = { stream, recorder, meter, chunks, startedAt, interval, limitReported: false };
    this.setState({ ...VOICE_NOTE_IDLE_STATE, phase: "recording" });
  }

  /**
   * Stops recording and returns the voice note, or null when nothing was
   * recorded. The state stays "sending" until {@link complete}.
   */
  async finish(): Promise<File | null> {
    const active = this.active;
    if (!active || this.state.phase !== "recording") return null;
    const session = this.session;
    this.setState({ ...this.state, phase: "sending" });
    clearInterval(active.interval);

    await new Promise<void>((resolve) => {
      active.recorder.onstop = () => resolve();
      if (active.recorder.state === "inactive") resolve();
      else active.recorder.stop();
    });
    active.meter?.close();
    releaseStream(active.stream);
    if (this.active === active) this.active = null;
    if (session !== this.session) return null;

    const { mimeType, extension } = voiceNoteFileType(active.recorder.mimeType);
    const blob = new Blob(active.chunks, { type: mimeType });
    if (blob.size === 0) {
      this.setState({ ...VOICE_NOTE_IDLE_STATE, phase: "error", error: "Nothing was recorded." });
      return null;
    }
    const startedAt = new Date(active.startedAt);
    return new File([blob], voiceNoteFileName(startedAt, extension), {
      type: mimeType,
      lastModified: this.dependencies.now(),
    });
  }

  /** The composer has taken the voice note; back to idle. */
  complete(): void {
    if (this.state.phase === "sending") this.setState(VOICE_NOTE_IDLE_STATE);
  }

  cancel(): void {
    this.session += 1;
    this.teardown({ stopRecorder: true });
    this.setState(VOICE_NOTE_IDLE_STATE);
  }

  dismissError(): void {
    if (this.state.phase === "error") this.setState(VOICE_NOTE_IDLE_STATE);
  }

  dispose(): void {
    this.session += 1;
    this.teardown({ stopRecorder: true });
  }

  private sample(session: number): void {
    const active = this.active;
    if (!active || session !== this.session || this.state.phase !== "recording") return;
    const elapsedSeconds = Math.floor((this.dependencies.now() - active.startedAt) / 1_000);
    let level = 0;
    try {
      level = normalizeVoiceNoteDecibels(active.meter?.readDecibels());
    } catch {
      level = 0;
    }
    const levels = [...this.state.levels.slice(1), level];
    this.setState({ ...this.state, elapsedSeconds, levels });
    if (!active.limitReported && elapsedSeconds >= VOICE_NOTE_LIMIT_SECONDS) {
      active.limitReported = true;
      this.dependencies.onLimitReached();
    }
  }

  private teardown(options: { readonly stopRecorder: boolean }): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    clearInterval(active.interval);
    active.recorder.ondataavailable = null;
    active.recorder.onstop = null;
    active.recorder.onerror = null;
    if (options.stopRecorder && active.recorder.state !== "inactive") {
      try {
        active.recorder.stop();
      } catch {
        // Already stopped by the browser.
      }
    }
    active.meter?.close();
    releaseStream(active.stream);
  }

  private setState(next: VoiceNoteState): void {
    this.state = next;
    this.dependencies.onChange(next);
  }
}

// ---------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------

type AudioContextConstructor = new () => AudioContext;

/** Level meter on an AnalyserNode; null where Web Audio is unavailable. */
export function createAnalyserLevelMeter(stream: MediaStream): VoiceNoteLevelMeter | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Context = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2_048;
  source.connect(analyser);
  // A context created after an await can start suspended; capture analysis
  // needs it running.
  void context.resume().catch(() => {});
  const buffer = new Float32Array(analyser.fftSize);
  return {
    readDecibels: () => {
      analyser.getFloatTimeDomainData(buffer);
      return rmsToDecibels(buffer);
    },
    close: () => {
      source.disconnect();
      void context.close().catch(() => {});
    },
  };
}

export function browserVoiceNoteDependencies(
  callbacks: Pick<VoiceNoteRecorderDependencies, "onChange" | "onLimitReached">,
): VoiceNoteRecorderDependencies {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createMediaRecorder: (stream, options) =>
      new MediaRecorder(stream, options) as unknown as VoiceNoteMediaRecorder,
    isTypeSupported: (type) =>
      typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(type),
    createLevelMeter: createAnalyserLevelMeter,
    now: () => Date.now(),
    ...callbacks,
  };
}
