import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useAssetUrl, useRefreshAssetUrl } from "../state/assets";
import {
  audioClock,
  audioSeekTime,
  claimAudioPlayback,
  releaseAudioPlayback,
} from "../lib/audioPlayback";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";

export function VoiceNoteAudio(props: {
  environmentId: EnvironmentId;
  attachment: ChatFileAttachment;
}) {
  const resource = useMemo(
    () =>
      ({
        _tag: "attachment",
        attachmentId: props.attachment.id,
        fileName: props.attachment.name,
        mimeType: props.attachment.mimeType,
        disposition: "inline",
      }) as const,
    [props.attachment],
  );
  const uri = useAssetUrl(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  const [refreshedUri, setRefreshedUri] = useState<string | null>(null);
  const player = useAudioPlayer(refreshedUri ?? uri, { updateInterval: 500 });
  const status = useAudioPlayerStatus(player);
  const retried = useRef(false);
  const refreshing = useRef(false);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => () => releaseAudioPlayback(player), [player]);
  useEffect(() => {
    if (!status.error) {
      if (status.isLoaded) refreshing.current = false;
      return;
    }
    if (refreshing.current) return;
    if (retried.current) {
      setError(true);
      return;
    }
    retried.current = true;
    refreshing.current = true;
    void refresh()
      .then((url) => {
        if (!url) {
          setError(true);
          return;
        }
        setRefreshedUri(url);
        player.replace({ uri: url });
        refreshing.current = false;
      })
      .catch(() => setError(true));
  }, [status.error, status.isLoaded, refresh, player]);
  return (
    <View style={{ width: 280, maxWidth: "100%" }} className="my-1 gap-1">
      <Text className="text-xs text-foreground">{props.attachment.name}</Text>
      <View className="flex-row items-center gap-2 rounded-full bg-subtle px-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? "Pause voice note" : "Play voice note"}
          disabled={!status.isLoaded}
          className="size-10 items-center justify-center"
          onPress={() => {
            if (status.playing) player.pause();
            else {
              claimAudioPlayback(player);
              if (status.didJustFinish)
                void player
                  .seekTo(0)
                  .then(() => player.play())
                  .catch(() => setError(true));
              else player.play();
            }
          }}
        >
          {status.playing ? (
            <Text className="text-foreground">Ⅱ</Text>
          ) : (
            <SymbolView name="play" size={16} tintColorClassName="accent-icon" />
          )}
        </Pressable>
        <Pressable
          accessibilityRole="adjustable"
          accessibilityLabel="Voice note position"
          accessibilityValue={{ min: 0, max: status.duration, now: status.currentTime }}
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) =>
            void player
              .seekTo(
                Math.max(
                  0,
                  Math.min(
                    status.duration,
                    status.currentTime + (event.nativeEvent.actionName === "increment" ? 5 : -5),
                  ),
                ),
              )
              .catch(() => setError(true))
          }
          className="flex-1 py-4"
          onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
          onPress={(event) =>
            void player
              .seekTo(audioSeekTime(event.nativeEvent.locationX, width, status.duration))
              .catch(() => setError(true))
          }
        >
          <View className="h-1 overflow-hidden rounded-full bg-subtle-strong">
            <View
              className="h-1 bg-foreground"
              style={{
                width: `${status.duration > 0 ? Math.min(1, status.currentTime / status.duration) * 100 : 0}%`,
              }}
            />
          </View>
        </Pressable>
        <Text className="text-2xs text-foreground-muted">
          {audioClock(status.currentTime)} / {audioClock(status.duration)}
        </Text>
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-xs text-foreground">
          Could not play this audio.
        </Text>
      ) : null}
    </View>
  );
}
