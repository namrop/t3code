import { describe, expect, it, vi } from "vite-plus/test";
import {
  claimVoiceNotePlayback,
  releaseVoiceNotePlayback,
  formatVoiceNoteClock,
  knownVoiceNoteDuration,
  voiceNoteSeekTime,
} from "./voiceNotePlayback";

describe("voice note playback", () => {
  it("only allows one recording to play", () => {
    const first = { paused: false, pause: vi.fn() } as unknown as HTMLMediaElement;
    const second = { paused: false, pause: vi.fn() } as unknown as HTMLMediaElement;
    claimVoiceNotePlayback(first);
    claimVoiceNotePlayback(second);
    expect(first.pause).toHaveBeenCalledOnce();
    releaseVoiceNotePlayback(first);
    claimVoiceNotePlayback(first);
    expect(second.pause).toHaveBeenCalledOnce();
    releaseVoiceNotePlayback(first);
  });
  it("formats measured and unknown duration", () => {
    expect(formatVoiceNoteClock(null)).toBe("--:--");
    expect(formatVoiceNoteClock(62.8)).toBe("1:02");
    expect(formatVoiceNoteClock(3662)).toBe("1:01:02");
    expect(knownVoiceNoteDuration(Infinity)).toBeNull();
    expect(knownVoiceNoteDuration(2.76)).toBe(2.76);
  });
  it("seeks proportionally, clamping to the recording", () => {
    const base = { trackLeft: 100, trackWidth: 200, duration: 10 };
    expect(voiceNoteSeekTime({ ...base, pointerX: 200 })).toBe(5);
    expect(voiceNoteSeekTime({ ...base, pointerX: -100 })).toBe(0);
    expect(voiceNoteSeekTime({ ...base, pointerX: 500 })).toBe(10);
  });
});
