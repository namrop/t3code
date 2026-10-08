type PlaybackSlot = { readonly pause: () => void };
let active: PlaybackSlot | null = null;

/** Voice notes and generated reply speech share one cancellable playback slot. */
export function claimAudioPlayback(slot: PlaybackSlot): void {
  if (active !== null && active !== slot) active.pause();
  active = slot;
}
export function releaseAudioPlayback(slot: PlaybackSlot): void {
  if (active === slot) active = null;
}
export function audioSeekTime(position: number, width: number, duration: number): number {
  return width > 0 ? Math.min(1, Math.max(0, position / width)) * duration : 0;
}
export function audioClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
