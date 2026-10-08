import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useTurnItemDetail } from "../state/queries";
import { voiceNoteTranscript } from "../features/voice-input/voiceNoteSession";
import { AppText as Text } from "./AppText";

/** Read complete tool output even when its work-log group is folded. */
export function VoiceNoteTranscript(props: {
  readonly environmentId: EnvironmentId;
  readonly row: OrchestrationV2ProjectedTurnItem;
}) {
  const detail = useTurnItemDetail({ environmentId: props.environmentId, row: props.row });
  const text = voiceNoteTranscript(detail.data?.item ?? props.row.item);
  return (
    <Text
      selectable
      accessibilityLabel="Voice note transcript"
      className="mt-2 text-sm text-foreground"
    >
      {text ?? (detail.error ? `Could not load transcript: ${detail.error}` : "Transcribing…")}
    </Text>
  );
}
