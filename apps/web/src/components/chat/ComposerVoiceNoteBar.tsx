import { MicIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  formatVoiceNoteElapsed,
  resolveVoiceNotePresentation,
  VOICE_NOTE_WAVEFORM_SAMPLE_COUNT,
  type VoiceNoteState,
} from "./composerVoiceNote";

// Waveform geometry from the phone app's dictation status
// (apps/mobile/src/features/voice-input/ComposerDictationControl.tsx).
const WAVEFORM_BAR_HEIGHT = 32;
const WAVEFORM_MIN_BAR_HEIGHT = 2;
const WAVEFORM_BAR_SPACING = 5;

/** Same footprint and colors as the composer's send button. */
const VOICE_NOTE_SEND_BUTTON_CLASS =
  "relative isolate flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-2xs enabled:inset-shadow-white/16 enabled:shadow-message-action/24 hover:scale-105 hover:bg-message-action-hover active:inset-shadow-black/8 active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8";

/** The toolbar flips into the voice bar the way the phone's dictation toolbar does. */
export const VOICE_NOTE_FLIP_IN_CLASS = "motion-safe:animate-voice-note-flip-in";
export const VOICE_NOTE_FLIP_BACK_CLASS = "motion-safe:animate-voice-note-flip-back";

function preventFocusSteal(event: { preventDefault: () => void }) {
  event.preventDefault();
}

export function ComposerVoiceNoteButton(props: {
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onStart: () => void;
}) {
  const label = props.label ?? "Record a voice note";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-chat-composer-voice-note-start="true"
            disabled={props.disabled}
            onPointerDown={preventFocusSteal}
            onClick={props.onStart}
            aria-label={label}
          />
        }
      >
        <MicIcon />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function VoiceNoteWaveform(props: { readonly levels: readonly number[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [barCount, setBarCount] = useState(0);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      setBarCount(
        Math.max(
          1,
          Math.min(
            VOICE_NOTE_WAVEFORM_SAMPLE_COUNT,
            Math.floor(container.clientWidth / WAVEFORM_BAR_SPACING),
          ),
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      data-chat-composer-voice-note-waveform="true"
      className="flex min-w-0 flex-1 items-center justify-between overflow-hidden"
      style={{ height: WAVEFORM_BAR_HEIGHT }}
    >
      {Array.from({ length: barCount }, (_, index) => {
        const level = props.levels[VOICE_NOTE_WAVEFORM_SAMPLE_COUNT - barCount + index] ?? 0;
        const scale =
          (WAVEFORM_MIN_BAR_HEIGHT + level * (WAVEFORM_BAR_HEIGHT - WAVEFORM_MIN_BAR_HEIGHT)) /
          WAVEFORM_BAR_HEIGHT;
        return (
          <span
            key={index}
            className="w-0.5 shrink-0 rounded-full bg-foreground transition-[opacity,transform] duration-100 ease-out motion-reduce:transition-none"
            style={{
              height: WAVEFORM_BAR_HEIGHT,
              opacity: 0.22 + level * 0.78,
              transform: `scaleY(${scale})`,
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * The composer toolbar while a voice note is recording: cancel, a live
 * waveform with the elapsed time, and send. Laid out like the phone app's
 * dictation toolbar; send replaces its checkmark because the recording itself
 * is what goes out.
 */
export function ComposerVoiceNoteBar(props: {
  readonly state: VoiceNoteState;
  readonly className?: string;
  readonly onCancel: () => void;
  readonly onSend: () => void;
  readonly onDismissError: () => void;
  readonly onRetry: () => void;
}) {
  const presentation = resolveVoiceNotePresentation(props.state);
  if (!presentation.showsBar) return null;
  const isError = presentation.statusKind === "error";

  return (
    <div
      data-chat-composer-voice-note="true"
      data-voice-note-phase={props.state.phase}
      className={cn(
        "flex h-9 min-w-0 items-center gap-1 backface-hidden sm:h-8",
        VOICE_NOTE_FLIP_IN_CLASS,
        props.className,
      )}
    >
      {presentation.showsCancel ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onPointerDown={preventFocusSteal}
          onClick={props.onCancel}
          aria-label="Cancel voice note"
        >
          <XIcon />
        </Button>
      ) : null}

      <div className="flex h-full min-w-0 flex-1 items-center">
        {isError ? (
          <div role="alert" className="flex min-w-0 flex-1 items-center gap-1.5 px-2">
            <p className="line-clamp-2 min-w-0 flex-1 text-sm text-destructive">
              {presentation.statusLabel}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onPointerDown={preventFocusSteal}
              onClick={props.onDismissError}
              aria-label="Dismiss voice note error"
            >
              <XIcon />
            </Button>
          </div>
        ) : presentation.statusKind === "waveform" ? (
          <div
            role="status"
            aria-label={presentation.statusLabel ?? undefined}
            className="flex min-w-0 flex-1 items-center gap-2 px-1"
          >
            <VoiceNoteWaveform levels={props.state.levels} />
            <span aria-hidden="true" className="text-xs text-muted-foreground tabular-nums">
              {formatVoiceNoteElapsed(props.state.elapsedSeconds)}
            </span>
          </div>
        ) : (
          <p
            role="status"
            className="min-w-0 flex-1 truncate px-2 text-center text-sm text-muted-foreground"
          >
            {presentation.statusLabel}
          </p>
        )}
      </div>

      {isError ? (
        <ComposerVoiceNoteButton label="Record again" onStart={props.onRetry} />
      ) : (
        <button
          type="button"
          data-chat-composer-voice-note-send="true"
          className={VOICE_NOTE_SEND_BUTTON_CLASS}
          disabled={!presentation.sendEnabled}
          onPointerDown={preventFocusSteal}
          onClick={props.onSend}
          aria-label={
            presentation.sendEnabled ? "Send voice note" : (presentation.statusLabel ?? "")
          }
          aria-busy={presentation.sendLoading || undefined}
        >
          {presentation.sendLoading ? (
            <Spinner size="sm" aria-hidden="true" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
