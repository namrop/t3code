import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Alert, AppState, Linking } from "react-native";
import * as Notifications from "expo-notifications";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import {
  estatePushState,
  reconcileEstatePush,
  supportsEstatePush,
} from "../agent-awareness/estatePush";
import { DEFAULT_ESTATE_PUSH_PREFERENCES, estatePushPlan } from "../agent-awareness/estatePushPlan";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const statusText = {
  disabled: "Off",
  pending: "Waiting for ntfy and Sol",
  registered: "Registered with Sol",
  failed: "Registration failed — check ntfy and Sol",
  "distributor-missing": "Install the ntfy Android app",
  unsupported: "Install a newer native app build",
};

/** Private Android configuration, intentionally independent of Clerk/cloud settings. */
export function LocalEstateNotificationsRouteScreen() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const { savedConnectionsById } = useSavedRemoteConnections();
  const [status, setStatus] = useState(estatePushState);
  const [permission, setPermission] = useState(false);
  const [busy, setBusy] = useState(false);
  const values = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  const events = values.estatePushPreferences ?? DEFAULT_ESTATE_PUSH_PREFERENCES;
  const paired =
    estatePushPlan(Object.values(savedConnectionsById), { ...values, estatePushEnabled: true }) !==
    null;
  useEffect(() => {
    const refresh = () => {
      setStatus(estatePushState());
      void Notifications.getPermissionsAsync()
        .then((result) => setPermission(result.granted))
        .catch(() => setPermission(false));
    };
    refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") refresh();
    }, 2000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, []);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    try {
      if (enabled) {
        const result = await runtime.runPromise(requestAgentNotificationPermission);
        if (result.type !== "granted") {
          Alert.alert(
            "Notifications are not allowed",
            "Allow T3 Code (Sol) notifications in Android settings first.",
          );
          return;
        }
        setPermission(true);
      } else await reconcileEstatePush(null); // local suppression is immediate, before persistence/network
      await save({ estatePushEnabled: enabled });
      setStatus(estatePushState());
    } catch {
      Alert.alert(
        "Could not save notification settings",
        "Try again. No successful registration is being claimed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4 pb-8"
      >
        <SettingsSection title="Sol · UnifiedPush">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Receive agent alerts"
            value={values.estatePushEnabled === true}
            disabled={
              busy || !AsyncResult.isSuccess(preferences) || !supportsEstatePush() || !paired
            }
            subtitle="Opt in on this device; delivery status is shown below"
            onValueChange={(enabled) => {
              void toggle(enabled);
            }}
          />
          <Text className="px-4 py-3 text-base text-foreground-muted">
            {paired
              ? statusText[status.status]
              : "Pair directly with T3 Code (Sol) first. Only one Sol bearer pairing is supported."}
            {values.estatePushEnabled && !permission
              ? " · Android notification permission is off."
              : ""}
            {status.pendingRemoval
              ? " · Remote removal is pending; local delivery is already off."
              : ""}
          </Text>
          <SettingsRow
            icon="gearshape"
            label="Android notification settings"
            onPress={() => {
              void Linking.openSettings();
            }}
          />
          <SettingsRow
            icon="arrow.clockwise"
            label="Retry registration"
            disabled={busy || !paired || !values.estatePushEnabled}
            onPress={() => {
              void reconcileEstatePush(
                estatePushPlan(Object.values(savedConnectionsById), values),
              ).catch(() => {
                Alert.alert(
                  "Registration could not start",
                  "Check the installed native app build and ntfy settings.",
                );
              });
            }}
          />
        </SettingsSection>
        <SettingsSection title="Events">
          {(
            [
              ["approval", "Approval needed"],
              ["input", "Input needed"],
              ["completed", "Run completed"],
              ["failed", "Run failed"],
            ] as const
          ).map(([kind, label]) => (
            <SettingsSwitchRow
              key={kind}
              icon="bell.badge"
              label={label}
              value={events[kind]}
              disabled={busy || !AsyncResult.isSuccess(preferences)}
              onValueChange={(enabled) => {
                void save({ estatePushPreferences: { ...events, [kind]: enabled } }).catch(() => {
                  Alert.alert("Could not save event preference", "Try again.");
                });
              }}
            />
          ))}
        </SettingsSection>
        <Text className="text-sm text-foreground-muted">
          In ntfy Settings, enable UnifiedPush and set the default server to
          https://ntfy.sol.pharos.zone. A sol-alerts subscription alone does not set the UnifiedPush
          server. T3 shows its own alerts; ntfy only delivers the messages. No T3 Connect or
          Firebase account is needed. Registered means Sol accepted this device, not that a
          notification was displayed.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
