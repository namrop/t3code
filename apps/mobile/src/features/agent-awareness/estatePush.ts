import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { estatePushPlan } from "./estatePushPlan";

interface NativeEstatePush {
  configureEstatePush(configuration: string, credential: string): Promise<string>;
  disableEstatePush(): Promise<void>;
  estatePushState(): string;
}
export interface EstatePushState {
  enabled: boolean;
  status: "disabled" | "pending" | "registered" | "failed" | "distributor-missing" | "unsupported";
  pendingRemoval?: boolean;
}
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeEstatePush>("T3AgentNotifications")
    : null;
export const supportsEstatePush = () =>
  typeof native?.configureEstatePush === "function" &&
  typeof native?.disableEstatePush === "function";
export function estatePushState(): EstatePushState {
  try {
    return supportsEstatePush()
      ? (JSON.parse(native!.estatePushState()) as EstatePushState)
      : { enabled: false, status: "unsupported" };
  } catch {
    return { enabled: false, status: "failed" };
  }
}

let installationId: Promise<string> | null = null;
function getInstallationId(): Promise<string> {
  if (!installationId)
    installationId = (async () => {
      const stored = await SecureStore.getItemAsync("estate.push.installation.v1");
      if (stored) return stored;
      const id = Crypto.randomUUID();
      await SecureStore.setItemAsync("estate.push.installation.v1", id);
      return id;
    })().catch((error: unknown) => {
      installationId = null;
      throw error;
    });
  return installationId;
}
let generation = 0;
export async function reconcileEstatePush(plan: ReturnType<typeof estatePushPlan>): Promise<void> {
  if (!supportsEstatePush() || plan === undefined) return;
  const expected = ++generation;
  if (!plan) {
    await native!.disableEstatePush();
    return;
  }
  const token = plan.connection.bearerToken!;
  const id = await getInstallationId();
  const pairHash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, token);
  if (expected !== generation) return;
  const scheme = Constants.expoConfig?.scheme;
  await native!.configureEstatePush(
    JSON.stringify({
      api_base: "https://t3.sol.pharos.zone/estate-push",
      device_id: `${id}.${pairHash.slice(0, 16)}`,
      scheme: (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code-sol",
      preferences: plan.preferences,
    }),
    token,
  );
}
