import { describe, expect, it } from "vite-plus/test";
import {
  claimAudioPlayback,
  releaseAudioPlayback,
  audioSeekTime,
  audioClock,
} from "./audioPlayback";

describe("mobile audio playback", () => {
  it("interrupts the previous slot including an in-flight speech request", () => {
    let stops = 0;
    const first = {
      pause: () => {
        stops += 1;
      },
    };
    const second = { pause: () => {} };
    claimAudioPlayback(first);
    claimAudioPlayback(first);
    expect(stops).toBe(0);
    claimAudioPlayback(second);
    expect(stops).toBe(1);
    releaseAudioPlayback(first);
    claimAudioPlayback(first);
    releaseAudioPlayback(first);
  });
  it("clamps track seeks and formats finite clocks", () => {
    expect(audioSeekTime(-5, 100, 30)).toBe(0);
    expect(audioSeekTime(150, 100, 30)).toBe(30);
    expect(audioSeekTime(50, 100, 30)).toBe(15);
    expect(audioSeekTime(20, 0, 30)).toBe(0);
    expect(audioClock(65)).toBe("1:05");
    expect(audioClock(Infinity)).toBe("--:--");
  });
});
