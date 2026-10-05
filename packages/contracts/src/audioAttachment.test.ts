import { describe, expect, it } from "vite-plus/test";
import { isAudioAttachment, audioAttachmentMimeType } from "./chatAttachment.ts";
describe("isAudioAttachment", () => {
  const file = (name: string, mimeType: string) => ({ type: "file" as const, name, mimeType });

  it("treats audio MIME types as voice notes", () => {
    expect(isAudioAttachment(file("note.m4a", "audio/mp4"))).toBe(true);
    expect(isAudioAttachment(file("note.webm", "audio/webm;codecs=opus"))).toBe(true);
    expect(isAudioAttachment(file("Recording.mp3", "AUDIO/MPEG"))).toBe(true);
  });

  it("falls back to audio-only extensions when the picker gives no audio type", () => {
    expect(isAudioAttachment(file("Recording 12.m4a", "application/octet-stream"))).toBe(true);
    expect(isAudioAttachment(file("memo.OGG", "application/octet-stream"))).toBe(true);
  });

  it("leaves video, documents and images alone", () => {
    expect(isAudioAttachment(file("clip.mp4", "video/mp4"))).toBe(false);
    expect(isAudioAttachment(file("clip.webm", "application/octet-stream"))).toBe(false);
    expect(isAudioAttachment(file("notes.txt", "text/plain"))).toBe(false);
    expect(isAudioAttachment({ type: "image", name: "a.png", mimeType: "image/png" })).toBe(false);
  });
});

describe("audioAttachmentMimeType", () => {
  it("keeps the picker's audio type and derives one from the extension otherwise", () => {
    expect(audioAttachmentMimeType({ name: "a.webm", mimeType: "audio/webm;codecs=opus" })).toBe(
      "audio/webm;codecs=opus",
    );
    expect(
      audioAttachmentMimeType({ name: "Recording.m4a", mimeType: "application/octet-stream" }),
    ).toBe("audio/mp4");
    expect(audioAttachmentMimeType({ name: "memo.ogg", mimeType: "" })).toBe("audio/ogg");
  });
});
