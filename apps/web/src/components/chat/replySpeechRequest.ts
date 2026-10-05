import type { EnvironmentId } from "@t3tools/contracts";
import { fetchEnvironmentReplySpeech } from "@t3tools/client-runtime/state/reply-speech";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPreparedConnection } from "../../state/session";

export async function requestReplySpeechAudio(
  environmentId: EnvironmentId,
  text: string,
  signal: AbortSignal,
): Promise<Blob> {
  const prepared = readPreparedConnection(environmentId);
  if (prepared === null) throw new Error("This reply's environment is disconnected.");
  const result = await executeAtomQuery(
    appAtomRegistry,
    connectionAtomRuntime.atom(fetchEnvironmentReplySpeech(prepared, text).pipe(Effect.scoped)),
    { signal, reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return new Blob([result.value], { type: "audio/mpeg" });
}
