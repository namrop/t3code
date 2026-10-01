import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  formatVoiceNoteElapsed,
  isVoiceNoteRecordingAvailable,
  normalizeVoiceNoteDecibels,
  pickVoiceNoteRecorderMimeType,
  providerTakesVoiceNotes,
  resolveVoiceNotePresentation,
  rmsToDecibels,
  VOICE_NOTE_BITS_PER_SECOND,
  VOICE_NOTE_IDLE_STATE,
  VOICE_NOTE_LIMIT_SECONDS,
  VOICE_NOTE_WAVEFORM_SAMPLE_COUNT,
  voiceNoteErrorMessage,
  voiceNoteFileName,
  voiceNoteFileType,
  voiceNoteHandoffStep,
  VoiceNoteRecorder,
  type VoiceNoteMediaRecorder,
  type VoiceNoteState,
} from "./composerVoiceNote";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pickVoiceNoteRecorderMimeType", () => {
  it("prefers Opus in WebM, then MP4, then Ogg", () => {
    const supports = (types: string[]) => (type: string) => types.includes(type);
    expect(pickVoiceNoteRecorderMimeType(supports(["audio/webm;codecs=opus", "audio/mp4"]))).toBe(
      "audio/webm;codecs=opus",
    );
    expect(pickVoiceNoteRecorderMimeType(supports(["audio/mp4", "audio/ogg;codecs=opus"]))).toBe(
      "audio/mp4",
    );
    expect(pickVoiceNoteRecorderMimeType(supports(["audio/ogg;codecs=opus"]))).toBe(
      "audio/ogg;codecs=opus",
    );
    expect(pickVoiceNoteRecorderMimeType(supports([]))).toBeUndefined();
  });
});

describe("voiceNoteFileType", () => {
  it("strips codec parameters and picks an extension Hermes's speech-to-text takes", () => {
    expect(voiceNoteFileType("audio/webm;codecs=opus")).toEqual({
      mimeType: "audio/webm",
      extension: "webm",
    });
    expect(voiceNoteFileType("audio/mp4;codecs=mp4a.40.2")).toEqual({
      mimeType: "audio/mp4",
      extension: "m4a",
    });
    expect(voiceNoteFileType("audio/ogg; codecs=opus")).toEqual({
      mimeType: "audio/ogg",
      extension: "ogg",
    });
    expect(voiceNoteFileType("")).toEqual({ mimeType: "audio/webm", extension: "webm" });
  });
});

describe("voiceNoteFileName", () => {
  it("names the recording by its local start time", () => {
    expect(voiceNoteFileName(new Date(2026, 9, 1, 1, 42, 7), "webm")).toBe(
      "Voice note 2026-10-01 01.42.07.webm",
    );
  });
});

describe("metering", () => {
  it("normalizes decibels the way the phone app's dictation waveform does", () => {
    expect(normalizeVoiceNoteDecibels(undefined)).toBe(0);
    expect(normalizeVoiceNoteDecibels(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalizeVoiceNoteDecibels(-60)).toBe(0);
    expect(normalizeVoiceNoteDecibels(0)).toBe(1);
    expect(normalizeVoiceNoteDecibels(3)).toBe(1);
    const floor = 10 ** (-60 / 20);
    expect(normalizeVoiceNoteDecibels(-20)).toBeCloseTo(Math.sqrt((0.1 - floor) / (1 - floor)));
  });

  it("measures the RMS level of a buffer in dBFS", () => {
    expect(rmsToDecibels(new Float32Array(8))).toBe(Number.NEGATIVE_INFINITY);
    expect(rmsToDecibels(Float32Array.from([1, -1, 1, -1]))).toBeCloseTo(0);
    expect(rmsToDecibels(Float32Array.from([0.1, -0.1, 0.1, -0.1]))).toBeCloseTo(-20);
  });
});

describe("formatVoiceNoteElapsed", () => {
  it("formats minutes and zero-padded seconds", () => {
    expect(formatVoiceNoteElapsed(0)).toBe("0:00");
    expect(formatVoiceNoteElapsed(65)).toBe("1:05");
    expect(formatVoiceNoteElapsed(14 * 60 + 59.9)).toBe("14:59");
  });
});

function FakeMediaRecorderConstructor() {}

describe("isVoiceNoteRecordingAvailable", () => {
  it("needs getUserMedia and MediaRecorder", () => {
    const getUserMedia = () => Promise.reject(new Error("unused"));
    expect(
      isVoiceNoteRecordingAvailable({
        navigator: { mediaDevices: { getUserMedia } },
        MediaRecorder: FakeMediaRecorderConstructor,
      }),
    ).toBe(true);
    expect(
      isVoiceNoteRecordingAvailable({ navigator: {}, MediaRecorder: FakeMediaRecorderConstructor }),
    ).toBe(false);
    expect(isVoiceNoteRecordingAvailable({ navigator: { mediaDevices: { getUserMedia } } })).toBe(
      false,
    );
    expect(isVoiceNoteRecordingAvailable({})).toBe(false);
  });
});

describe("providerTakesVoiceNotes", () => {
  it("offers voice notes only where the provider hears them", () => {
    expect(providerTakesVoiceNotes("hermes")).toBe(true);
    expect(providerTakesVoiceNotes("codex")).toBe(false);
    expect(providerTakesVoiceNotes("claudeAgent")).toBe(false);
  });
});

describe("voiceNoteErrorMessage", () => {
  it("says what went wrong with the microphone", () => {
    expect(voiceNoteErrorMessage(new DOMException("denied", "NotAllowedError"))).toBe(
      "Microphone access is blocked. Allow it for this site in your browser settings.",
    );
    expect(voiceNoteErrorMessage(new DOMException("none", "NotFoundError"))).toBe(
      "No microphone was found.",
    );
    expect(voiceNoteErrorMessage(new DOMException("busy", "NotReadableError"))).toBe(
      "The microphone is in use by another app.",
    );
    expect(voiceNoteErrorMessage(new Error("boom"))).toBe("Could not start recording.");
  });
});

describe("voiceNoteHandoffStep", () => {
  const base = {
    landed: true,
    uploadsToServer: true,
    uploadStatus: "ready" as const,
    sendBlocked: false,
  };

  it("waits until the recording is in the draft", () => {
    expect(voiceNoteHandoffStep({ ...base, landed: false })).toBe("wait");
  });

  it("waits while the recording uploads, since the composer cannot send until then", () => {
    expect(voiceNoteHandoffStep({ ...base, uploadStatus: null, sendBlocked: true })).toBe("wait");
    expect(voiceNoteHandoffStep({ ...base, uploadStatus: "uploading", sendBlocked: true })).toBe(
      "wait",
    );
  });

  it("sends once the upload is ready and nothing else blocks sending", () => {
    expect(voiceNoteHandoffStep(base)).toBe("send");
  });

  it("sends without an upload on servers that take attachments inline", () => {
    expect(voiceNoteHandoffStep({ ...base, uploadsToServer: false, uploadStatus: null })).toBe(
      "send",
    );
  });

  it("hands the draft back when the upload failed or sending is blocked for another reason", () => {
    expect(voiceNoteHandoffStep({ ...base, uploadStatus: "failed", sendBlocked: true })).toBe(
      "release",
    );
    expect(voiceNoteHandoffStep({ ...base, sendBlocked: true })).toBe("release");
  });
});

describe("resolveVoiceNotePresentation", () => {
  const state = (overrides: Partial<VoiceNoteState>): VoiceNoteState => ({
    ...VOICE_NOTE_IDLE_STATE,
    ...overrides,
  });

  it("shows nothing while idle", () => {
    expect(resolveVoiceNotePresentation(VOICE_NOTE_IDLE_STATE).showsBar).toBe(false);
  });

  it("mirrors the phone dictation toolbar: cancel, waveform and timer, then send", () => {
    expect(resolveVoiceNotePresentation(state({ phase: "preparing" }))).toEqual({
      showsBar: true,
      showsCancel: true,
      statusKind: "label",
      statusLabel: "Preparing",
      sendEnabled: false,
      sendLoading: true,
    });
    expect(resolveVoiceNotePresentation(state({ phase: "recording", elapsedSeconds: 7 }))).toEqual({
      showsBar: true,
      showsCancel: true,
      statusKind: "waveform",
      statusLabel: "Recording 0:07",
      sendEnabled: true,
      sendLoading: false,
    });
    expect(resolveVoiceNotePresentation(state({ phase: "sending" }))).toEqual({
      showsBar: true,
      showsCancel: false,
      statusKind: "label",
      statusLabel: "Sending",
      sendEnabled: false,
      sendLoading: true,
    });
  });

  it("shows an error with a way to dismiss it", () => {
    expect(
      resolveVoiceNotePresentation(state({ phase: "error", error: "No microphone was found." })),
    ).toEqual({
      showsBar: true,
      showsCancel: false,
      statusKind: "error",
      statusLabel: "No microphone was found.",
      sendEnabled: false,
      sendLoading: false,
    });
  });
});

// ---------------------------------------------------------------------------
// VoiceNoteRecorder
// ---------------------------------------------------------------------------

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream() {
  const track = new FakeTrack();
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

class FakeMediaRecorder implements VoiceNoteMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  readonly mimeType: string;
  ondataavailable: ((event: { readonly data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  timeslice: number | undefined;
  stopCalls = 0;
  finalChunk: string | null = "-tail";

  constructor(
    readonly stream: MediaStream,
    readonly options: { readonly mimeType?: string; readonly audioBitsPerSecond?: number },
  ) {
    this.mimeType = options.mimeType ?? "audio/webm;codecs=opus";
  }

  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) });
  }

  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
    if (this.finalChunk !== null) this.emit(this.finalChunk);
    this.onstop?.();
  }
}

function setup(options?: {
  getUserMedia?: () => Promise<MediaStream>;
  supported?: string[];
  meterDecibels?: () => number;
}) {
  const { stream, track } = fakeStream();
  const states: VoiceNoteState[] = [];
  const recorders: FakeMediaRecorder[] = [];
  const meterClosed = { value: false };
  const getUserMedia = vi.fn(options?.getUserMedia ?? (() => Promise.resolve(stream)));
  const onLimitReached = vi.fn();
  const recorder = new VoiceNoteRecorder({
    getUserMedia,
    createMediaRecorder: (mediaStream, recorderOptions) => {
      const created = new FakeMediaRecorder(mediaStream, recorderOptions);
      recorders.push(created);
      return created;
    },
    isTypeSupported: (type) =>
      (options?.supported ?? ["audio/webm;codecs=opus", "audio/mp4"]).includes(type),
    createLevelMeter: () => ({
      readDecibels: options?.meterDecibels ?? (() => -20),
      close: () => {
        meterClosed.value = true;
      },
    }),
    now: () => Date.now(),
    onChange: (state) => states.push(state),
    onLimitReached,
  });
  return { recorder, stream, track, states, recorders, meterClosed, getUserMedia, onLimitReached };
}

describe("VoiceNoteRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 1, 1, 42, 7));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the microphone and starts a compact Opus recording", async () => {
    const { recorder, states, recorders, getUserMedia } = setup();
    await recorder.start();

    expect(states.map((state) => state.phase)).toEqual(["preparing", "recording"]);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.options).toEqual({
      mimeType: "audio/webm;codecs=opus",
      audioBitsPerSecond: VOICE_NOTE_BITS_PER_SECOND,
    });
    expect(recorders[0]!.timeslice).toBe(1000);
  });

  it("finishes into a voice-note file and releases the microphone", async () => {
    const { recorder, track, recorders, meterClosed } = setup();
    await recorder.start();
    recorders[0]!.emit("head");

    const file = await recorder.finish();

    expect(file).not.toBeNull();
    expect(file!.name).toBe("Voice note 2026-10-01 01.42.07.webm");
    expect(file!.type).toBe("audio/webm");
    expect(await file!.text()).toBe("head-tail");
    expect(track.stopped).toBe(true);
    expect(meterClosed.value).toBe(true);
    expect(recorder.currentState.phase).toBe("sending");

    recorder.complete();
    expect(recorder.currentState).toEqual(VOICE_NOTE_IDLE_STATE);
  });

  it("uses the browser's container when Opus in WebM is unavailable", async () => {
    const { recorder } = setup({ supported: ["audio/mp4"] });
    await recorder.start();
    const file = await recorder.finish();
    expect(file!.name.endsWith(".m4a")).toBe(true);
    expect(file!.type).toBe("audio/mp4");
  });

  it("cancel discards the recording and releases the microphone", async () => {
    const { recorder, track, recorders } = setup();
    await recorder.start();
    recorders[0]!.emit("head");

    recorder.cancel();

    expect(recorders[0]!.stopCalls).toBe(1);
    expect(track.stopped).toBe(true);
    expect(recorder.currentState).toEqual(VOICE_NOTE_IDLE_STATE);
    expect(await recorder.finish()).toBeNull();
  });

  it("cancel while the permission prompt is open releases the stream once it arrives", async () => {
    let resolve: (stream: MediaStream) => void = () => {};
    const pending = new Promise<MediaStream>((done) => {
      resolve = done;
    });
    const { recorder, stream, track, recorders } = setup({ getUserMedia: () => pending });
    const starting = recorder.start();
    expect(recorder.currentState.phase).toBe("preparing");

    recorder.cancel();
    resolve(stream);
    await starting;

    expect(recorders).toHaveLength(0);
    expect(track.stopped).toBe(true);
    expect(recorder.currentState).toEqual(VOICE_NOTE_IDLE_STATE);
  });

  it("reports a blocked microphone and can be dismissed", async () => {
    const { recorder } = setup({
      getUserMedia: () => Promise.reject(new DOMException("denied", "NotAllowedError")),
    });
    await recorder.start();
    expect(recorder.currentState.phase).toBe("error");
    expect(recorder.currentState.error).toBe(
      "Microphone access is blocked. Allow it for this site in your browser settings.",
    );

    recorder.dismissError();
    expect(recorder.currentState).toEqual(VOICE_NOTE_IDLE_STATE);
  });

  it("updates the timer and waveform while recording", async () => {
    let decibels = -60;
    const { recorder } = setup({ meterDecibels: () => decibels });
    await recorder.start();
    decibels = 0;

    vi.advanceTimersByTime(1_040);

    const state = recorder.currentState;
    expect(state.elapsedSeconds).toBe(1);
    expect(state.levels).toHaveLength(VOICE_NOTE_WAVEFORM_SAMPLE_COUNT);
    expect(state.levels.at(-1)).toBe(1);
    expect(state.levels[0]).toBe(0);
  });

  it("asks to send once the length limit is reached", async () => {
    const { recorder, onLimitReached } = setup();
    await recorder.start();

    vi.advanceTimersByTime(VOICE_NOTE_LIMIT_SECONDS * 1_000 + 200);

    expect(onLimitReached).toHaveBeenCalledTimes(1);
  });

  it("an empty recording is an error, not an empty file", async () => {
    const { recorder, recorders } = setup();
    await recorder.start();
    recorders[0]!.finalChunk = null;

    expect(await recorder.finish()).toBeNull();
    expect(recorder.currentState.phase).toBe("error");
    expect(recorder.currentState.error).toBe("Nothing was recorded.");
  });

  it("dispose stops an active recording", async () => {
    const { recorder, track, recorders } = setup();
    await recorder.start();
    recorder.dispose();
    expect(recorders[0]!.stopCalls).toBe(1);
    expect(track.stopped).toBe(true);
  });
});
