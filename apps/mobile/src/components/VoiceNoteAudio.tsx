import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";
import { useAssetUrl } from "../state/assets";
import { AudioFilePreview } from "./AudioFilePreview";
import { AppText as Text } from "./AppText";

export function VoiceNoteAudio(props: {
  environmentId: EnvironmentId;
  attachment: ChatFileAttachment;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
  });
  return (
    <View style={{ width: 280, maxWidth: "100%" }} className="my-1 gap-1">
      <Text className="text-xs text-foreground">{props.attachment.name}</Text>
      {uri ? (
        <AudioFilePreview key={uri} uri={uri} compact onRetry={() => {}} />
      ) : (
        <Text className="text-xs text-foreground-muted">Connecting to load audio…</Text>
      )}
    </View>
  );
}
