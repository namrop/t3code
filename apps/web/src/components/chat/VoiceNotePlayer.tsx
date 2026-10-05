import type { EnvironmentId } from "@t3tools/contracts";
import { PauseIcon, PlayIcon } from "lucide-react";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { audioAttachmentMimeType } from "@t3tools/contracts";
import type { ChatFileAttachment } from "../../types";
import { Button } from "../ui/button";
import {
  claimVoiceNotePlayback,
  formatVoiceNoteClock,
  knownVoiceNoteDuration,
  releaseVoiceNotePlayback,
  voiceNoteSeekTime,
} from "./voiceNotePlayback";

const KEYBOARD_SEEK_SECONDS = 5;
/** What the agent heard. Render the complete output, never the tool-log preview. */
export function VoiceNoteTranscript(props: { readonly text: string }) {
  return (
    <figure className="mt-2" data-voice-note-transcript="true">
      <figcaption className="sr-only">Voice note transcript</figcaption>
      <blockquote className="whitespace-pre-wrap break-words text-sm text-message-foreground/80">
        {props.text}
      </blockquote>
    </figure>
  );
}

/**
 * Inline player for a recording attached to a message, in place of its file chip.
 * Built from spans so it can sit inside message prose. When the recording cannot be
 * loaded, the regular chip (`fallback`) comes back so the file stays reachable.
 */
export function VoiceNotePlayer(props: {
  readonly attachment: ChatFileAttachment;
  readonly environmentId: EnvironmentId | null;
  readonly copyMarkdown?: string | undefined;
  readonly fallback: ReactNode;
}) {
  const { attachment, environmentId } = props;
  const resource = useMemo(
    () =>
      attachment.downloadable === false
        ? null
        : {
            _tag: "attachment" as const,
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: audioAttachmentMimeType(attachment) ?? attachment.mimeType,
            disposition: "inline" as const,
          },
    [attachment],
  );
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(environmentId, resource);
  const [refreshedSrc, setRefreshedSrc] = useState<string | null>(null);
  const src =
    attachment.previewUrl ?? refreshedSrc ?? (assetUrl._tag === "Success" ? assetUrl.url : null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const probingDurationRef = useRef(false);
  const retriedRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const attachAudio = useCallback((element: HTMLAudioElement | null) => {
    if (element === null && audioRef.current !== null) {
      releaseVoiceNotePlayback(audioRef.current);
    }
    audioRef.current = element;
  }, []);

  const learnDuration = useCallback((audio: HTMLAudioElement) => {
    const known = knownVoiceNoteDuration(audio.duration);
    if (known === null) return false;
    setDuration(known);
    if (probingDurationRef.current) {
      probingDurationRef.current = false;
      audio.currentTime = 0;
    }
    return true;
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || learnDuration(audio)) return;
    // Recorded WebM has no duration header; seeking past the end makes the browser
    // read the tail and report the real length, then the playhead goes back to 0.
    probingDurationRef.current = true;
    audio.currentTime = Number.MAX_SAFE_INTEGER;
  }, [learnDuration]);

  const onTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (probingDurationRef.current) {
      learnDuration(audio);
      return;
    }
    setCurrentTime(audio.currentTime);
  }, [learnDuration]);

  const onError = useCallback(() => {
    if (attachment.previewUrl === undefined && !retriedRef.current) {
      // Signed links expire; one fresh link before giving up.
      retriedRef.current = true;
      void refreshAssetUrl()
        .then((url) => (url ? setRefreshedSrc(url) : setFailed(true)))
        .catch(() => setFailed(true));
      return;
    }
    setFailed(true);
  }, [attachment.previewUrl, refreshAssetUrl]);

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || src === null) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    probingDurationRef.current = false;
    if (audio.ended) audio.currentTime = 0;
    claimVoiceNotePlayback(audio);
    void audio.play().catch(() => setPlaying(false));
  }, [src]);

  const seekTo = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    probingDurationRef.current = false;
    audio.currentTime = seconds;
    setCurrentTime(seconds);
  }, []);

  const onTrackPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (duration === null) return;
      const rect = event.currentTarget.getBoundingClientRect();
      seekTo(
        voiceNoteSeekTime({
          pointerX: event.clientX,
          trackLeft: rect.left,
          trackWidth: rect.width,
          duration,
        }),
      );
    },
    [duration, seekTo],
  );

  const onTrackKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (duration === null) return;
      const step =
        event.key === "ArrowRight"
          ? KEYBOARD_SEEK_SECONDS
          : event.key === "ArrowLeft"
            ? -KEYBOARD_SEEK_SECONDS
            : null;
      if (step === null) return;
      event.preventDefault();
      seekTo(Math.min(duration, Math.max(0, currentTime + step)));
    },
    [currentTime, duration, seekTo],
  );

  if (failed) return <>{props.fallback}</>;

  const progress = duration === null ? 0 : Math.min(1, currentTime / duration);
  const showElapsed = playing || currentTime > 0;
  const clock = formatVoiceNoteClock(showElapsed ? currentTime : duration);

  return (
    <span
      className="inline-flex w-64 max-w-full items-center gap-2 rounded-full border border-border/70 bg-background/60 py-0.5 ps-0.5 pe-3 align-middle"
      data-voice-note-player="true"
      data-voice-note-state={playing ? "playing" : src === null ? "loading" : "paused"}
      data-markdown-copy={props.copyMarkdown}
    >
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={src === null}
        aria-label={playing ? `Pause ${attachment.name}` : `Play ${attachment.name}`}
        onClick={togglePlayback}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <span
        role="slider"
        tabIndex={duration === null ? -1 : 0}
        aria-label={`Position in ${attachment.name}`}
        aria-valuemin={0}
        aria-valuemax={duration === null ? 0 : Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatVoiceNoteClock(currentTime)} of ${formatVoiceNoteClock(duration)}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center py-2"
        onPointerDown={onTrackPointerDown}
        onKeyDown={onTrackKeyDown}
      >
        <span className="relative block h-1 w-full overflow-hidden rounded-full bg-foreground/15">
          <span
            className="absolute inset-y-0 start-0 block rounded-full bg-foreground/70"
            style={{ width: `${progress * 100}%` }}
          />
        </span>
      </span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{clock}</span>
      {src !== null ? (
        <audio
          ref={attachAudio}
          src={src}
          preload="metadata"
          className="hidden"
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={onTimeUpdate}
          onTimeUpdate={onTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setCurrentTime(0);
          }}
          onError={onError}
        />
      ) : null}
    </span>
  );
}
