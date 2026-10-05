export type ReplySpeechPlaybackState =
  | { readonly messageId: null; readonly phase: "idle" }
  | { readonly messageId: string; readonly phase: "loading" | "playing" };

interface ReplySpeechPlaybackDependencies {
  readonly requestAudio: (text: string, signal: AbortSignal) => Promise<Blob>;
  readonly createAudio?: () => HTMLAudioElement;
  readonly createObjectUrl: (audio: Blob) => string;
  readonly revokeObjectUrl: (url: string) => void;
  readonly onStateChange: (state: ReplySpeechPlaybackState) => void;
  readonly onError: (error: Error) => void;
}

interface ActivePlayback {
  readonly messageId: string;
  readonly audio: HTMLAudioElement;
  readonly controller: AbortController;
  objectUrl: string | null;
}

function silentWavDataUrl(): string {
  const sampleCount = 800;
  const bytes = new Uint8Array(44 + sampleCount);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + sampleCount, true);
  writeAscii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 8_000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeAscii(36, "data");
  view.setUint32(40, sampleCount, true);
  bytes.fill(128, 44);

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const IDLE_STATE: ReplySpeechPlaybackState = { messageId: null, phase: "idle" };

/** One timeline-wide controller keeps replies mutually exclusive and cancellable. */
export function createReplySpeechPlayback(dependencies: ReplySpeechPlaybackDependencies) {
  let active: ActivePlayback | null = null;

  const publishIdle = () => dependencies.onStateChange(IDLE_STATE);

  const stopActive = () => {
    const previous = active;
    if (previous === null) return;

    active = null;
    previous.controller.abort();
    previous.audio.onended = null;
    previous.audio.onerror = null;
    previous.audio.pause();
    previous.audio.src = "";
    previous.audio.load();
    if (previous.objectUrl !== null) dependencies.revokeObjectUrl(previous.objectUrl);
    publishIdle();
  };

  const failActive = (playback: ActivePlayback, cause: unknown) => {
    if (active !== playback) return;
    stopActive();
    dependencies.onError(
      cause instanceof Error ? cause : new Error("Could not play this reply as speech."),
    );
  };

  const toggle = (messageId: string, text: string): Promise<void> | void => {
    if (active?.messageId === messageId) {
      stopActive();
      return;
    }
    stopActive();

    const audio = dependencies.createAudio?.() ?? new Audio();
    const playback: ActivePlayback = {
      messageId,
      audio,
      controller: new AbortController(),
      objectUrl: null,
    };
    active = playback;
    dependencies.onStateChange({ messageId, phase: "loading" });

    // Safari and Android Chrome require media playback to begin in the click's
    // user-activation turn. Unlock this element with a short muted WAV before
    // awaiting the authenticated speech request; the same element then plays
    // the generated audio when it arrives.
    audio.muted = true;
    audio.src = silentWavDataUrl();
    try {
      void audio.play().catch(() => undefined);
    } catch {
      // The real audio play below will report a visible failure if the element
      // could not be unlocked on this browser.
    }

    return (async () => {
      try {
        const blob = await dependencies.requestAudio(text, playback.controller.signal);
        if (active !== playback) return;

        audio.pause();
        playback.objectUrl = dependencies.createObjectUrl(blob);
        audio.src = playback.objectUrl;
        audio.muted = false;
        audio.onended = () => stopActive();
        audio.onerror = () =>
          failActive(playback, new Error("Could not play this reply as speech."));
        await audio.play();
        if (active === playback) {
          dependencies.onStateChange({ messageId, phase: "playing" });
        }
      } catch (cause) {
        failActive(playback, cause);
      }
    })();
  };

  return {
    toggle,
    stop: stopActive,
    dispose: stopActive,
  };
}
