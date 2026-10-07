import { describe, expect, it } from "vite-plus/test";
import { estatePushPlan } from "./estatePushPlan";
import type { SavedRemoteConnection } from "../../lib/connection";

const sol = {
  environmentId: "sol",
  environmentLabel: "Sol",
  displayUrl: "https://t3.sol.pharos.zone",
  pairingUrl: "",
  wsBaseUrl: "wss://t3.sol.pharos.zone",
  httpBaseUrl: "https://t3.sol.pharos.zone",
  bearerToken: "paired-example-token",
} as SavedRemoteConnection;

describe("local estate push opt-in and origin boundary", () => {
  it("defaults OFF for existing installations", () => {
    expect(estatePushPlan([sol], {})).toBeNull();
  });
  it("uses only an existing direct Sol bearer", () => {
    expect(estatePushPlan([sol], { estatePushEnabled: true })?.connection).toBe(sol);
  });
  it.each([
    "http://t3.sol.pharos.zone",
    "https://t3.sol.pharos.zone.evil.example",
    "https://t3.sol.pharos.zone:9443",
    "https://user:secret@t3.sol.pharos.zone",
    "https://t3.sol.pharos.zone/somewhere",
    "https://t3.sol.pharos.zone?redirect=evil",
  ])("rejects %s without forwarding its bearer", (httpBaseUrl) => {
    expect(estatePushPlan([{ ...sol, httpBaseUrl }], { estatePushEnabled: true })).toBeNull();
  });
  it("never reuses a cloud-managed connection", () => {
    expect(
      estatePushPlan([{ ...sol, relayManaged: true }], { estatePushEnabled: true }),
    ).toBeNull();
  });
  it("requires a bearer and fails closed on ambiguous Sol pairings", () => {
    expect(estatePushPlan([{ ...sol, bearerToken: null }], { estatePushEnabled: true })).toBeNull();
    expect(
      estatePushPlan([sol, { ...sol, bearerToken: "other" }], { estatePushEnabled: true }),
    ).toBeNull();
  });
  it("preserves all four explicit per-event preferences", () => {
    const preferences = { approval: true, input: false, completed: false, failed: true };
    expect(
      estatePushPlan([sol], { estatePushEnabled: true, estatePushPreferences: preferences })
        ?.preferences,
    ).toEqual(preferences);
  });
});
