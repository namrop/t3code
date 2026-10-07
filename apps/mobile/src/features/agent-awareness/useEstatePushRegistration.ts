import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect } from "react";
import { AppState, Platform } from "react-native";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { hasCloudPublicConfig } from "../cloud/publicConfig";
import { estatePushPlan } from "./estatePushPlan";
import { reconcileEstatePush } from "./estatePush";

/** Private Android local route; no Clerk, FCM token or managed relay dependency. */
export function useEstatePushRegistration(): void {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const refresh = useCallback(() => {
    if (
      Platform.OS !== "android" ||
      hasCloudPublicConfig() ||
      isLoadingSavedConnection ||
      !AsyncResult.isSuccess(preferences)
    )
      return;
    const plan = estatePushPlan(Object.values(savedConnectionsById), preferences.value);
    // Native status is deliberately separate from desired opt-in. A failed
    // registration must not be reported as registered, or log a bearer error.
    void reconcileEstatePush(plan).catch(() => {});
  }, [isLoadingSavedConnection, preferences, savedConnectionsById]);
  useEffect(() => {
    refresh();
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => listener.remove();
  }, [refresh]);
}
