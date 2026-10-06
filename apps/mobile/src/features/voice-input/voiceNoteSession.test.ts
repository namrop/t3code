import { describe, expect, it } from "vite-plus/test";
import { voiceNoteTranscript, providerTakesVoiceNotes, VoiceNoteSession } from "./voiceNoteSession";

describe("native voice notes", () => {
  it("negotiates audio rather than trusting provider names", () => {
    expect(providerTakesVoiceNotes({ supportsAudioPrompts: true })).toBe(true);
    expect(providerTakesVoiceNotes({ supportsAudioPrompts: false })).toBe(false);
    expect(providerTakesVoiceNotes(null)).toBe(false);
  });
  it("shows completed transcript text, not raw JSON or other tools", () => {
    expect(
      voiceNoteTranscript({
        type: "dynamic_tool",
        status: "completed",
        toolName: "voice_note_transcript",
        output: [{ type: "text", text: "Test spoken note." }],
      }),
    ).toBe("Test spoken note.");
    expect(
      voiceNoteTranscript({
        type: "dynamic_tool",
        status: "inProgress",
        toolName: "voice_note_transcript",
        output: "unfinished",
      }),
    ).toBeNull();
    expect(
      voiceNoteTranscript({
        type: "dynamic_tool",
        status: "completed",
        toolName: "Read",
        output: "not a transcript",
      }),
    ).toBeNull();
  });
  const setup = (granted = true) => {
    const calls: string[] = [];
    const session = new VoiceNoteSession({
      requestPermission: async () => granted,
      prepare: async () => {
        calls.push("prepare");
      },
      record: () => {
        calls.push("record");
      },
      stop: async () => {
        calls.push("stop");
        return "file:///note.m4a";
      },
      release: async () => {
        calls.push("release");
      },
      deleteRecording: async () => {
        calls.push("delete");
      },
      onChange: () => {},
    });
    return { session, calls };
  };
  it("hands a real recording to the draft once and releases audio", async () => {
    const { session, calls } = setup();
    await session.start();
    expect(session.phase).toBe("recording");
    expect(await session.finish()).toBe("file:///note.m4a");
    expect(await session.finish()).toBeNull();
    expect(calls).toEqual(["prepare", "record", "stop", "release"]);
  });
  it("does not start without mic permission", async () => {
    const { session, calls } = setup(false);
    await session.start();
    expect(session.phase).toBe("error");
    expect(calls).toEqual([]);
  });
  it("deletes cancelled recordings and releases audio", async () => {
    const { session, calls } = setup();
    await session.start();
    await session.cancel();
    expect(calls).toEqual(["prepare", "record", "stop", "delete", "release"]);
    expect(session.phase).toBe("idle");
  });
  it("survives Android's temporary permission activity pause", async () => {
    const calls: string[] = [];
    let session!: VoiceNoteSession;
    session = new VoiceNoteSession({
      requestPermission: async () => {
        await session.onAppBackground();
        return true;
      },
      prepare: async () => {
        calls.push("prepare");
      },
      record: () => {
        calls.push("record");
      },
      stop: async () => "file:///note.m4a",
      release: async () => {},
      deleteRecording: async () => {},
      onChange: () => {},
    });
    await session.start();
    expect(session.phase).toBe("recording");
    expect(calls).toEqual(["prepare", "record"]);
  });
  it("still cancels a recording when the app really backgrounds", async () => {
    const { session, calls } = setup();
    await session.start();
    await session.onAppBackground();
    expect(session.phase).toBe("idle");
    expect(calls).toEqual(["prepare", "record", "stop", "delete", "release"]);
  });
  it("cancellation during permission cannot start recording later", async () => {
    let grant!: (value: boolean) => void;
    let prepared = false;
    const session = new VoiceNoteSession({
      requestPermission: () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
      prepare: async () => {
        prepared = true;
      },
      record: () => {},
      stop: async () => null,
      release: async () => {},
      deleteRecording: async () => {},
      onChange: () => {},
    });
    const start = session.start();
    await session.cancel();
    grant(true);
    await start;
    expect(prepared).toBe(false);
    expect(session.phase).toBe("idle");
  });
});
