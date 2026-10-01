import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { VOICE_NOTE_IDLE_STATE, type VoiceNoteState } from "./composerVoiceNote";
import { ComposerVoiceNoteBar, ComposerVoiceNoteButton } from "./ComposerVoiceNoteBar";

const noop = () => {};

function renderBar(state: Partial<VoiceNoteState>) {
  return renderToStaticMarkup(
    createElement(ComposerVoiceNoteBar, {
      state: { ...VOICE_NOTE_IDLE_STATE, ...state },
      onCancel: noop,
      onSend: noop,
      onDismissError: noop,
      onRetry: noop,
    }),
  );
}

describe("ComposerVoiceNoteButton", () => {
  it("is a labelled microphone button", () => {
    const markup = renderToStaticMarkup(createElement(ComposerVoiceNoteButton, { onStart: noop }));
    expect(markup).toContain('aria-label="Record a voice note"');
    expect(markup).toContain('data-chat-composer-voice-note-start="true"');
    expect(markup).toContain("lucide-mic");
  });
});

describe("ComposerVoiceNoteBar", () => {
  it("renders nothing while idle", () => {
    expect(renderBar({})).toBe("");
  });

  it("while recording shows cancel, the waveform with the timer, and send", () => {
    const markup = renderBar({ phase: "recording", elapsedSeconds: 75 });
    expect(markup).toContain('aria-label="Cancel voice note"');
    expect(markup).toContain('data-chat-composer-voice-note-waveform="true"');
    expect(markup).toContain('aria-label="Recording 1:15"');
    expect(markup).toContain(">1:15<");
    expect(markup).toContain('aria-label="Send voice note"');
    expect(markup).toContain('type="button"');
    expect(markup).not.toMatch(/data-chat-composer-voice-note-send="true"[^>]*\sdisabled=""/);
    expect(markup).toContain("motion-safe:animate-voice-note-flip-in");
  });

  it("while preparing shows the label and a busy, disabled send", () => {
    const markup = renderBar({ phase: "preparing" });
    expect(markup).toContain(">Preparing<");
    expect(markup).toContain('aria-label="Cancel voice note"');
    expect(markup).toMatch(/data-chat-composer-voice-note-send="true"[^>]*\sdisabled=""/);
    expect(markup).toContain('aria-busy="true"');
  });

  it("while sending hides cancel", () => {
    const markup = renderBar({ phase: "sending" });
    expect(markup).toContain(">Sending<");
    expect(markup).not.toContain('aria-label="Cancel voice note"');
  });

  it("shows an error with dismiss and record-again", () => {
    const markup = renderBar({ phase: "error", error: "No microphone was found." });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("No microphone was found.");
    expect(markup).toContain('aria-label="Dismiss voice note error"');
    expect(markup).toContain('aria-label="Record again"');
    expect(markup).not.toContain('aria-label="Send voice note"');
  });
});
