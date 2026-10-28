import { isAudioAttachment, type OrchestrationV2ConversationMessage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const TurnAuthor = Schema.Struct({
  version: Schema.Literal(1),
  author: Schema.Literals(["luis", "machine"]),
  via: Schema.Literals(["t3", "discord", "runtime", "paperclip"]),
  kind: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,64}$/)),
});

// Excess keys are invalid, not silently stripped. Validation never gates a turn.
const matchesTurnAuthor = Schema.is(TurnAuthor);
export function isTurnAuthor(value: unknown): value is typeof TurnAuthor.Type {
  return matchesTurnAuthor(value) && Object.keys(value).length === 4;
}

/** Use the persisted creator's provenance before context/instructions are wrapped around it. */
export function t3TurnAuthor(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "attachments" | "delegatedCompletion" | "scheduledTaskId"
  >,
  options?: { readonly handoff?: boolean; readonly replay?: boolean },
): typeof TurnAuthor.Type | undefined {
  const label = (author: "luis" | "machine", kind: string): typeof TurnAuthor.Type => ({
    version: 1,
    author,
    via: "t3",
    kind,
  });
  if (options?.replay) return label("machine", options.handoff ? "handoff" : "continuation");
  if (message.scheduledTaskId !== undefined) return label("machine", "scheduled_task");
  if (
    message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile")
  ) {
    return label("luis", message.attachments.some(isAudioAttachment) ? "voice_note" : "typed");
  }
  if (message.createdBy !== "agent" && message.createdBy !== "system") return undefined;
  if (message.delegatedCompletion !== undefined) return label("machine", "task_notification");
  if (options?.handoff) return label("machine", "handoff");
  if (message.creationSource === "server" || message.creationSource === "mcp") {
    return label("machine", "agent_message");
  }
  return undefined;
}
