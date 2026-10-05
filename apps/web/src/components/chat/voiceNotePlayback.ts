/** Clock text for a voice note: `m:ss`, or `h:mm:ss` past an hour. Unknown reads `--:--`. */
export function formatVoiceNoteClock(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${secs}` : `${minutes}:${secs}`;
}

/**
 * The finite length of a recording, or null while the browser does not know it yet.
 * MediaRecorder WebM files ship without a duration header, so `duration` reads
 * Infinity until the element has seen the end of the file.
 */
export function knownVoiceNoteDuration(duration: number): number | null {
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/** Playhead position from a pointer on the track, clamped to the recording. */
export function voiceNoteSeekTime(input: {
  readonly pointerX: number;
  readonly trackLeft: number;
  readonly trackWidth: number;
  readonly duration: number;
}): number {
  if (input.trackWidth <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, (input.pointerX - input.trackLeft) / input.trackWidth));
  return ratio * input.duration;
}

let playingElement: HTMLMediaElement | null = null;

/** One recording plays at a time: starting one pauses whichever was playing. */
export function claimVoiceNotePlayback(element: HTMLMediaElement): void {
  if (playingElement !== null && playingElement !== element && !playingElement.paused) {
    playingElement.pause();
  }
  playingElement = element;
}

export function releaseVoiceNotePlayback(element: HTMLMediaElement): void {
  if (playingElement === element) playingElement = null;
}
