import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  type RecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { AppState, Platform, View } from "react-native";
import { ComposerActionButton } from "../../components/ComposerToolbar";
import { AppText as Text } from "../../components/AppText";
import { createComposerFileAttachment } from "../../lib/composerImages";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
} from "../../state/use-composer-drafts";
import { VoiceNoteSession, type VoiceNotePhase } from "./voiceNoteSession";

/** Mounted only for a provider advertising audio prompts. No phone-local STT required. */
export function ComposerVoiceNote(props: {
  readonly draftKey: string;
  readonly disabled?: boolean;
  readonly maxBytes: number;
  readonly sendBlocked: boolean;
  readonly onSend: () => Promise<unknown>;
  readonly onBusyChange?: (busy: boolean) => void;
}) {
  const [state, setState] = useState<{ phase: VoiceNotePhase; error: string | null }>({
    phase: "idle",
    error: null,
  });
  const [elapsed, setElapsed] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const recorder = useRef<InstanceType<typeof AudioModule.AudioRecorder> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const sessionRef = useRef<VoiceNoteSession | null>(null);
  if (!sessionRef.current)
    sessionRef.current = new VoiceNoteSession({
      requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
      prepare: async () => {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
        });
        const preset = RecordingPresets.HIGH_QUALITY;
        recorder.current = new AudioModule.AudioRecorder({
          extension: ".m4a",
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 32000,
          ...(Platform.OS === "ios" ? preset.ios : preset.android),
        });
        await recorder.current.prepareToRecordAsync();
      },
      record: () => recorder.current?.record({ forDuration: 15 * 60 }),
      stop: async () => {
        await recorder.current?.stop();
        return recorder.current?.uri ?? null;
      },
      release: async () => {
        recorder.current?.release();
        recorder.current = null;
        await setAudioModeAsync({ allowsRecording: false });
      },
      deleteRecording: async (uri) => {
        const file = new File(uri);
        if (file.exists) file.delete();
      },
      onChange: (phase, error) => setState({ phase, error }),
    });
  const session = sessionRef.current;
  const busy =
    state.phase === "preparing" ||
    state.phase === "recording" ||
    state.phase === "finishing" ||
    attaching;
  useEffect(() => {
    props.onBusyChange?.(busy);
  }, [busy, props.onBusyChange]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background") void session.onAppBackground();
    });
    return () => {
      subscription.remove();
      void session.cancel();
    };
  }, [session]);
  useEffect(() => {
    if (state.phase !== "recording") return;
    setElapsed(0);
    const timer = setInterval(() => {
      const status: RecorderState | undefined = recorder.current?.getStatus();
      const seconds = Math.floor((status?.durationMillis ?? 0) / 1000);
      setElapsed(seconds);
      if (seconds >= 15 * 60) void finish();
    }, 1000);
    return () => clearInterval(timer);
  }, [state.phase]);
  // Wait for the updated draft/render before invoking the parent's current send
  // callback. Its normal durable outbox owns uploads, offline delivery and retry.
  useEffect(() => {
    if (!pendingId || attaching || props.sendBlocked) return;
    if (!getComposerDraftSnapshot(props.draftKey).attachments.some((file) => file.id === pendingId))
      return;
    setPendingId(null);
    void props.onSend().catch((error) =>
      setState({
        phase: "error",
        error:
          error instanceof Error
            ? error.message
            : "Could not send; the note is saved in the draft.",
      }),
    );
  }, [pendingId, attaching, props.sendBlocked, props.onSend, props.draftKey]);
  async function finish() {
    if (session.phase !== "recording") return;
    setAttaching(true);
    let uri: string | null = null;
    try {
      uri = await session.finish();
      if (!uri) return;
      const captured = latest.current;
      const attachment = await createComposerFileAttachment({
        uri,
        name: `Voice note ${new Date().toISOString().replace(/[:]/g, ".")}.m4a`,
        mimeType: "audio/mp4",
        sizeBytes: null,
        maxBytes: captured.maxBytes,
      });
      if (
        appendComposerDraftAttachments(captured.draftKey, [attachment], {
          appendReference: true,
        }) !== 0
      )
        throw new Error("The draft has too many attachments.");
      setPendingId(attachment.id);
    } catch (error) {
      setState({
        phase: "error",
        error: error instanceof Error ? error.message : "Could not save the voice note.",
      });
    } finally {
      if (uri) {
        const file = new File(uri);
        if (file.exists) file.delete();
      }
      setAttaching(false);
    }
  }
  return (
    <View className="flex-row items-center">
      {state.phase === "recording" ? (
        <>
          <ComposerActionButton
            accessibilityLabel="Cancel voice note"
            icon="xmark"
            onPress={() => void session.cancel()}
          />
          <Text className="text-xs text-foreground">
            {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </Text>
          <ComposerActionButton
            accessibilityLabel="Send voice note"
            icon="arrow.up"
            variant="primary"
            onPress={() => void finish()}
          />
        </>
      ) : (
        <ComposerActionButton
          accessibilityLabel={busy ? "Preparing voice note" : "Record voice note"}
          icon="mic"
          disabled={props.disabled || busy || pendingId !== null}
          onPress={() => void session.start()}
        />
      )}
      {state.error ? (
        <Text accessibilityRole="alert" className="max-w-48 text-xs text-foreground">
          {state.error}
        </Text>
      ) : null}
    </View>
  );
}
