import type { SavedRemoteConnection } from "../../lib/connection";
import type { Preferences } from "../../persistence/mobile-preferences";

export type EstatePushPreferences = Readonly<
  Record<"approval" | "input" | "completed" | "failed", boolean>
>;
export const DEFAULT_ESTATE_PUSH_PREFERENCES: EstatePushPreferences = {
  approval: true,
  input: true,
  completed: true,
  failed: true,
};

export function estatePushPlan(
  connections: readonly SavedRemoteConnection[],
  preferences: Preferences,
) {
  if (preferences.estatePushEnabled !== true) return null;
  const eligible = connections.filter((connection) => {
    if (
      !connection.bearerToken ||
      connection.authenticationMethod === "dpop" ||
      connection.relayManaged
    )
      return false;
    try {
      const url = new URL(connection.httpBaseUrl);
      return (
        url.protocol === "https:" &&
        url.hostname === "t3.sol.pharos.zone" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        ["", "/"].includes(url.pathname)
      );
    } catch {
      return false;
    }
  });
  // This private v1 consumer targets one Sol pairing; ambiguous credentials are
  // not silently chosen. Other apps can add their own explicit origin/config.
  if (eligible.length !== 1) return null;
  return {
    connection: eligible[0]!,
    preferences: preferences.estatePushPreferences ?? DEFAULT_ESTATE_PUSH_PREFERENCES,
  };
}
