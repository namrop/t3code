import type { EnvironmentId } from "@t3tools/contracts";
import { fetchEnvironmentReplySpeech } from "@t3tools/client-runtime/state/reply-speech";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { usePreparedConnection } from "../state/session";
import { claimAudioPlayback, releaseAudioPlayback } from "../lib/audioPlayback";
import { AppText as Text } from "./AppText";

type SpeechState = {
  readonly messageId: string;
  readonly phase: "idle" | "loading" | "playing" | "error";
  readonly error?: string;
};

export function MessageListenButton(props: {
  readonly environmentId: EnvironmentId;
  readonly messageId: string;
  readonly text: string;
}) {
  const prepared = usePreparedConnection(props.environmentId);
  const player = useAudioPlayer(null, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const [state, setState] = useState<SpeechState>({ messageId: props.messageId, phase: "idle" });
  const active = useRef<AbortController | null>(null);
  const file = useRef<File | null>(null);
  const slot = useMemo(
    () => ({
      pause: () => {
        active.current?.abort();
        active.current = null;
        player.pause();
        player.replace(null);
        if (file.current?.exists) file.current.delete();
        file.current = null;
        setState({ messageId: props.messageId, phase: "idle" });
      },
    }),
    [player, props.messageId],
  );
  useEffect(
    () => () => {
      slot.pause();
      releaseAudioPlayback(slot);
    },
    [slot],
  );
  useEffect(() => {
    if (status.error) {
      slot.pause();
      releaseAudioPlayback(slot);
      // Native playback errors arrive asynchronously through the player status.
      // oxlint-disable-next-line react/set-state-in-effect
      setState({ messageId: props.messageId, phase: "error", error: "Could not play this reply." });
    } else if (status.didJustFinish) {
      slot.pause();
      releaseAudioPlayback(slot);
    }
  }, [status.error, status.didJustFinish, slot, props.messageId]);
  const toggle = async () => {
    if (active.current) {
      slot.pause();
      releaseAudioPlayback(slot);
      return;
    }
    if (prepared._tag !== "Some") {
      setState({
        messageId: props.messageId,
        phase: "error",
        error: "Connect to listen to this reply.",
      });
      return;
    }
    const controller = new AbortController();
    claimAudioPlayback(slot);
    active.current = controller;
    setState({ messageId: props.messageId, phase: "loading" });
    try {
      const result = await executeAtomQuery(
        appAtomRegistry,
        connectionAtomRuntime.atom(
          fetchEnvironmentReplySpeech(prepared.value, props.text).pipe(Effect.scoped),
        ),
        { signal: controller.signal, reportFailure: false, reportDefect: false },
      );
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const bytes = result.value;
      if (active.current !== controller) return;
      const audio = new File(
        Paths.cache,
        `reply-speech-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
      );
      audio.create();
      audio.write(bytes);
      file.current = audio;
      player.replace({ uri: audio.uri });
      player.play();
      setState({ messageId: props.messageId, phase: "playing" });
    } catch (cause) {
      if (active.current !== controller) return;
      slot.pause();
      releaseAudioPlayback(slot);
      setState({
        messageId: props.messageId,
        phase: "error",
        error: cause instanceof Error ? cause.message : "Could not generate speech.",
      });
    }
  };
  const label =
    state.phase === "loading"
      ? "Cancel speech"
      : state.phase === "playing"
        ? "Stop speaking"
        : "Listen to reply";
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ busy: state.phase === "loading" }}
        className="min-h-7 px-2 justify-center"
        onPress={() => void toggle()}
      >
        <Text className="text-xs text-foreground-muted">
          {state.phase === "loading" ? "Loading…" : state.phase === "playing" ? "Stop" : "Listen"}
        </Text>
      </Pressable>
      {state.error ? (
        <Text accessibilityRole="alert" className="text-xs text-foreground">
          {state.error}
        </Text>
      ) : null}
    </View>
  );
}
