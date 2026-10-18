import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const fetchAudio = vi.fn(async (_url: string) => ({ arrayBuffer: async () => new ArrayBuffer(2) }));
const start = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchAudio);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      destination = {};
      resume = async () => {};
      decodeAudioData = async () => ({});
      createBufferSource = () => ({ buffer: null, connect: vi.fn(), start });
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["completion", "notification-completion.mp3"],
  ["approval", "notification-approval.mp3"],
  ["input", "notification-input.mp3"],
])("plays the correct asset for %s without changing other alert kinds", async (kind, asset) => {
  const { playNotificationSound, unlockNotificationAudio } = await import("./threadNotifications");
  unlockNotificationAudio();
  await playNotificationSound(kind as Parameters<typeof playNotificationSound>[0], () => true);
  expect(fetchAudio).toHaveBeenCalledTimes(1);
  expect(fetchAudio.mock.calls[0]?.[0]).toContain(asset);
  expect(start).toHaveBeenCalledOnce();
});

it("does not play when sound was disabled while decoding", async () => {
  const { playNotificationSound, unlockNotificationAudio } = await import("./threadNotifications");
  unlockNotificationAudio();
  await playNotificationSound("completion", () => false);
  expect(start).not.toHaveBeenCalled();
});

it("does not initialize playback without the existing user gesture", async () => {
  const { playNotificationSound } = await import("./threadNotifications");
  await playNotificationSound("completion", () => true);
  expect(fetchAudio).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});
