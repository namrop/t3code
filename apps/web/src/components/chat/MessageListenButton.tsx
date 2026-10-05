import { AudioLinesIcon, SquareIcon, Volume2Icon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ReplySpeechPlaybackState } from "./replySpeechPlayback";

export function MessageListenButton({
  messageId,
  text,
  playbackState,
  onToggle,
}: {
  readonly messageId: string;
  readonly text: string;
  readonly playbackState: ReplySpeechPlaybackState;
  readonly onToggle: (messageId: string, text: string) => void;
}) {
  const isActive = playbackState.messageId === messageId;
  const isLoading = isActive && playbackState.phase === "loading";
  const isPlaying = isActive && playbackState.phase === "playing";
  const label = isPlaying ? "Stop speaking" : isLoading ? "Cancel speech" : "Listen to reply";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-busy={isLoading}
            onClick={() => onToggle(messageId, text)}
            size="icon-xs"
            type="button"
            variant="ghost-muted"
          />
        }
      >
        {isPlaying ? <SquareIcon /> : isLoading ? <AudioLinesIcon /> : <Volume2Icon />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
}
