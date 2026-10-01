import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  browserVoiceNoteDependencies,
  isVoiceNoteRecordingAvailable,
  VOICE_NOTE_IDLE_STATE,
  VoiceNoteRecorder,
  type VoiceNoteState,
} from "./composerVoiceNote";

function voiceNoteRecordingAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return isVoiceNoteRecordingAvailable(
    window as unknown as Parameters<typeof isVoiceNoteRecordingAvailable>[0],
  );
}

/**
 * Drives one {@link VoiceNoteRecorder} for the composer. `onRecorded` gets the
 * finished file and resolves false when the composer could not take it (the
 * recorder then returns to idle); otherwise call `complete` once the composer
 * has dispatched it.
 */
export function useComposerVoiceNote(options: {
  readonly onRecorded: (file: File) => Promise<boolean> | boolean;
}) {
  const [state, setState] = useState<VoiceNoteState>(VOICE_NOTE_IDLE_STATE);
  const [available] = useState(voiceNoteRecordingAvailable);
  // The recorder outlives renders and must call the latest handler.
  const onRecordedRef = useRef(options.onRecorded);
  useLayoutEffect(() => {
    onRecordedRef.current = options.onRecorded;
  });
  const recorderRef = useRef<VoiceNoteRecorder | null>(null);

  const finishAndHandOver = useCallback(async (recorder: VoiceNoteRecorder) => {
    const file = await recorder.finish();
    if (!file) return;
    let accepted = false;
    try {
      accepted = await onRecordedRef.current(file);
    } catch {
      accepted = false;
    }
    if (!accepted) recorder.complete();
  }, []);

  const getRecorder = useCallback((): VoiceNoteRecorder => {
    if (!recorderRef.current) {
      const recorder: VoiceNoteRecorder = new VoiceNoteRecorder(
        browserVoiceNoteDependencies({
          onChange: setState,
          onLimitReached: () => void finishAndHandOver(recorder),
        }),
      );
      recorderRef.current = recorder;
    }
    return recorderRef.current;
  }, [finishAndHandOver]);

  useEffect(
    () => () => {
      recorderRef.current?.dispose();
      recorderRef.current = null;
    },
    [],
  );

  const start = useCallback(() => {
    void getRecorder().start();
  }, [getRecorder]);
  const send = useCallback(() => {
    void finishAndHandOver(getRecorder());
  }, [finishAndHandOver, getRecorder]);
  const cancel = useCallback(() => recorderRef.current?.cancel(), []);
  const dismissError = useCallback(() => recorderRef.current?.dismissError(), []);
  const complete = useCallback(() => recorderRef.current?.complete(), []);

  return { state, available, start, send, cancel, dismissError, complete };
}
