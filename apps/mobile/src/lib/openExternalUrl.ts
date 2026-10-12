import { parseAtriumLink } from "@t3tools/client-runtime/atrium-links";
import * as Schema from "effect/Schema";
import { Alert, Linking } from "react-native";

const ExternalUrlTarget = Schema.Literals([
  "file-preview",
  "markdown-link",
  "pull-request",
  "provider-auth",
]);

export type ExternalUrlTarget = typeof ExternalUrlTarget.Type;

export type AtriumObjectRouteParams = {
  readonly environmentId: string;
  readonly threadId?: string;
  /** The authored reference, including normalized body/query context. */
  readonly reference: string;
};

export interface AtriumReaderScope {
  readonly environmentId: string;
  readonly threadId?: string | null;
  readonly openAtriumObject: (params: AtriumObjectRouteParams) => void;
}

export class ExternalUrlOpenError extends Schema.TaggedError<ExternalUrlOpenError>()(
  "ExternalUrlOpenError",
  {
    target: ExternalUrlTarget,
    scheme: Schema.String,
    host: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to open ${this.target} URL with the ${this.scheme} scheme.`;
  }
}

function externalUrlMetadata(url: string): { readonly scheme: string; readonly host?: string } {
  try {
    const parsed = new URL(url);
    return {
      scheme: parsed.protocol.replace(/:$/, "") || "unknown",
      host: parsed.hostname || undefined,
    };
  } catch {
    return {
      scheme: /^([a-z][a-z\d+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? "unknown",
    };
  }
}

export async function tryOpenExternalUrl(
  url: string,
  target: ExternalUrlTarget,
  atriumScope?: AtriumReaderScope,
): Promise<boolean> {
  const atrium = target === "markdown-link" ? parseAtriumLink(url) : null;
  if (atrium?.kind === "unsupported") {
    Alert.alert("Unsupported Atrium link", atrium.message);
    return false;
  }
  if (atrium?.kind === "object" && atriumScope) {
    atriumScope.openAtriumObject({
      environmentId: atriumScope.environmentId,
      ...(atriumScope.threadId ? { threadId: atriumScope.threadId } : {}),
      reference: atrium.reference,
    });
    return true;
  }
  const destination = atrium?.kind === "object" ? atrium.readerUrl : url;
  try {
    await Linking.openURL(destination);
    return true;
  } catch (cause) {
    const error = new ExternalUrlOpenError({ target, ...externalUrlMetadata(destination), cause });
    console.error(error.message, {
      _tag: error._tag,
      target: error.target,
      scheme: error.scheme,
      host: error.host,
      stack: error.stack,
    });
    if (atrium) {
      Alert.alert(
        "Unable to open Atrium note",
        "The Atrium reader could not be opened. Try the link again.",
      );
    }
    return false;
  }
}
