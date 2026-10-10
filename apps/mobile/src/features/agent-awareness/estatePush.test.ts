import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { estatePushPlan } from "./estatePushPlan";
import type { SavedRemoteConnection } from "../../lib/connection";

const native = vi.hoisted(() => ({
  configureEstatePush: vi.fn().mockResolvedValue(undefined),
  disableEstatePush: vi.fn().mockResolvedValue(undefined),
  estatePushState: vi.fn(),
}));
const storage = vi.hoisted(() => ({
  getItemAsync: vi.fn().mockResolvedValue("test-installation"),
  setItemAsync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { scheme: "t3code-sol" } } }));
vi.mock("expo-secure-store", () => storage);
vi.mock("expo-crypto", () => ({
  randomUUID: () => "test-installation",
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn().mockResolvedValue("0123456789abcdef"),
}));

const sol = {
  environmentId: "sol",
  environmentLabel: "Sol",
  displayUrl: "https://t3.sol.pharos.zone",
  pairingUrl: "",
  wsBaseUrl: "wss://t3.sol.pharos.zone",
  httpBaseUrl: "https://t3.sol.pharos.zone",
  bearerToken: "paired-test-token",
} as SavedRemoteConnection;
const enabled = { estatePushEnabled: true };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  storage.getItemAsync.mockResolvedValue("test-installation");
});

describe("estate push connection pause versus explicit opt-out", () => {
  it("does not revoke a registration when the prepared bearer disappears", async () => {
    const { reconcileEstatePush } = await import("./estatePush");
    await reconcileEstatePush(estatePushPlan([sol], enabled));
    await reconcileEstatePush(estatePushPlan([{ ...sol, bearerToken: null }], enabled));
    expect(native.configureEstatePush).toHaveBeenCalledTimes(1);
    expect(native.disableEstatePush).not.toHaveBeenCalled();
  });

  it("does not cancel a pending registration when the connection pauses", async () => {
    const { reconcileEstatePush } = await import("./estatePush");
    let finish!: (id: string) => void;
    storage.getItemAsync.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const registering = reconcileEstatePush(estatePushPlan([sol], enabled));
    await reconcileEstatePush(estatePushPlan([{ ...sol, bearerToken: null }], enabled));
    finish("test-installation");
    await registering;
    expect(native.configureEstatePush).toHaveBeenCalledTimes(1);
    expect(native.disableEstatePush).not.toHaveBeenCalled();
  });

  it("revokes immediately when the user opts out during a connection pause", async () => {
    const { reconcileEstatePush } = await import("./estatePush");
    await reconcileEstatePush(estatePushPlan([sol], enabled));
    await reconcileEstatePush(
      estatePushPlan([{ ...sol, bearerToken: null }], { estatePushEnabled: false }),
    );
    expect(native.disableEstatePush).toHaveBeenCalledTimes(1);
  });

  it("revokes when the saved pairing is removed", async () => {
    const { reconcileEstatePush } = await import("./estatePush");
    await reconcileEstatePush(estatePushPlan([sol], enabled));
    await reconcileEstatePush(estatePushPlan([], enabled));
    expect(native.disableEstatePush).toHaveBeenCalledTimes(1);
  });

  it("does not complete an in-flight registration after explicit opt-out", async () => {
    const { reconcileEstatePush } = await import("./estatePush");
    let finish!: (id: string) => void;
    storage.getItemAsync.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const registering = reconcileEstatePush(estatePushPlan([sol], enabled));
    await reconcileEstatePush(estatePushPlan([], { estatePushEnabled: false }));
    finish("test-installation");
    await registering;
    expect(native.configureEstatePush).not.toHaveBeenCalled();
    expect(native.disableEstatePush).toHaveBeenCalledTimes(1);
  });
});
