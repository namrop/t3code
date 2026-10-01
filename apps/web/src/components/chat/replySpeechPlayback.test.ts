import { describe, expect, it } from "vite-plus/test";

import { createReplySpeechPlayback } from "./replySpeechPlayback.ts";

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeAudio() {
  return {
    src: "",
    muted: false,
    playCount: 0,
    paused: false,
    onended: null as (() => void) | null,
    onerror: null as (() => void) | null,
    play() {
      this.playCount += 1;
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {},
  };
}

describe("reply speech playback", () => {
  it("unlocks audio in the click call before awaiting the speech request", async () => {
    const audio = fakeAudio();
    const response = deferred<Blob>();
    const states: string[] = [];
    let requestStarted = false;
    const playback = createReplySpeechPlayback({
      requestAudio: () => {
        requestStarted = true;
        return response.promise;
      },
      createAudio: () => audio as unknown as HTMLAudioElement,
      createObjectUrl: () => "blob:speech",
      revokeObjectUrl: () => undefined,
      onStateChange: (state) => states.push(`${state.messageId ?? "-"}:${state.phase}`),
      onError: () => undefined,
    });

    const pending = playback.toggle("message-1", "Hello");

    expect(audio.playCount).toBe(1);
    expect(audio.src.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(audio.muted).toBe(true);
    expect(requestStarted).toBe(true);
    expect(states).toEqual(["message-1:loading"]);

    response.resolve(new Blob(["audio"], { type: "audio/mpeg" }));
    await pending;

    expect(audio.src).toBe("blob:speech");
    expect(audio.muted).toBe(false);
    expect(audio.playCount).toBe(2);
    expect(states.at(-1)).toBe("message-1:playing");
  });

  it("stops the first reply when a different reply is requested", async () => {
    const firstAudio = fakeAudio();
    const secondAudio = fakeAudio();
    const firstResponse = deferred<Blob>();
    const secondResponse = deferred<Blob>();
    const signals: AbortSignal[] = [];
    let audioIndex = 0;
    const playback = createReplySpeechPlayback({
      requestAudio: (_text, signal) => {
        signals.push(signal);
        return signals.length === 1 ? firstResponse.promise : secondResponse.promise;
      },
      createAudio: () => [firstAudio, secondAudio][audioIndex++] as unknown as HTMLAudioElement,
      createObjectUrl: () => "blob:speech",
      revokeObjectUrl: () => undefined,
      onStateChange: () => undefined,
      onError: () => undefined,
    });

    const firstPending = playback.toggle("message-1", "First reply");
    const secondPending = playback.toggle("message-2", "Second reply");

    expect(signals[0]?.aborted).toBe(true);
    expect(firstAudio.paused).toBe(true);
    expect(secondAudio.playCount).toBe(1);

    firstResponse.resolve(new Blob(["stale audio"], { type: "audio/mpeg" }));
    secondResponse.resolve(new Blob(["current audio"], { type: "audio/mpeg" }));
    await Promise.all([firstPending, secondPending]);

    expect(firstAudio.playCount).toBe(1);
    expect(secondAudio.playCount).toBe(2);
  });

  it("stops the active reply when its button is toggled again", async () => {
    const audio = fakeAudio();
    const response = deferred<Blob>();
    const states: string[] = [];
    const playback = createReplySpeechPlayback({
      requestAudio: () => response.promise,
      createAudio: () => audio as unknown as HTMLAudioElement,
      createObjectUrl: () => "blob:speech",
      revokeObjectUrl: () => undefined,
      onStateChange: (state) => states.push(`${state.messageId ?? "-"}:${state.phase}`),
      onError: () => undefined,
    });

    const pending = playback.toggle("message-1", "Hello");
    playback.toggle("message-1", "Hello");
    expect(audio.paused).toBe(true);
    expect(states.at(-1)).toBe("-:idle");

    response.resolve(new Blob(["stale audio"], { type: "audio/mpeg" }));
    await pending;

    expect(audio.playCount).toBe(1);
    expect(states.at(-1)).toBe("-:idle");
  });

  it("returns to idle and reports a failed request", async () => {
    const audio = fakeAudio();
    const errors: Error[] = [];
    const states: string[] = [];
    const playback = createReplySpeechPlayback({
      requestAudio: async () => {
        throw new Error("Speech service unavailable");
      },
      createAudio: () => audio as unknown as HTMLAudioElement,
      createObjectUrl: () => "blob:speech",
      revokeObjectUrl: () => undefined,
      onStateChange: (state) => states.push(`${state.messageId ?? "-"}:${state.phase}`),
      onError: (error) => errors.push(error),
    });

    await playback.toggle("message-1", "Hello");

    expect(errors.map((error) => error.message)).toEqual(["Speech service unavailable"]);
    expect(states).toEqual(["message-1:loading", "-:idle"]);
  });
});
