import { Alert, Linking } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { tryOpenExternalUrl } from "./openExternalUrl";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
}));

const openURL = vi.mocked(Linking.openURL);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tryOpenExternalUrl", () => {
  it("opens scoped Atrium objects inside T3 and preserves the complete reference", async () => {
    const reference =
      "atrium://uid/01900000-0000-7000-8000-000000000001?rel=source&why=Read+first&fallback=url%3Ahttps%3A%2F%2Fexample.com";
    const openAtriumObject = vi.fn();
    await expect(
      tryOpenExternalUrl(reference, "markdown-link", {
        environmentId: "environment-1",
        threadId: "thread-1",
        openAtriumObject,
      }),
    ).resolves.toBe(true);
    expect(openAtriumObject).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment-1",
      threadId: "thread-1",
      reference,
    });
    expect(openURL).not.toHaveBeenCalled();
  });

  it("keeps environment-scoped draft links inside T3 even without a thread", async () => {
    const reference = "uid:01900000-0000-7000-8000-000000000001";
    const openAtriumObject = vi.fn();
    await tryOpenExternalUrl(reference, "markdown-link", {
      environmentId: "environment-1",
      threadId: null,
      openAtriumObject,
    });
    expect(openAtriumObject).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment-1",
      reference,
    });
    expect(openURL).not.toHaveBeenCalled();
  });

  it.each(["https://example.com", "mailto:hello@example.com", "file:///tmp/Note.md"])(
    "does not reroute ordinary scoped links: %s",
    async (reference) => {
      openURL.mockResolvedValue(undefined);
      const openAtriumObject = vi.fn();
      await tryOpenExternalUrl(reference, "markdown-link", {
        environmentId: "environment-1",
        threadId: "thread-1",
        openAtriumObject,
      });
      expect(openURL).toHaveBeenCalledExactlyOnceWith(reference);
      expect(openAtriumObject).not.toHaveBeenCalled();
    },
  );

  it("opens an Atrium object in the estate reader without launching its OS scheme", async () => {
    openURL.mockResolvedValue(undefined);
    const reference =
      "atrium://uid/01900000-0000-7000-8000-000000000001?rel=source&why=Read+first&fallback=url%3Ahttps%3A%2F%2Fexample.com";
    await expect(tryOpenExternalUrl(reference, "markdown-link")).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledExactlyOnceWith(
      "https://atrium.sol.pharos.zone/?note=01900000-0000-7000-8000-000000000001&rel=source&why=Read+first&fallback=url%3Ahttps%3A%2F%2Fexample.com",
    );
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it.each([
    "atrium://beam/example",
    "atrium://uid/not-a-uid",
    "uid:01900000-0000-7000-8000-000000000001?revision=1",
  ])(
    "explains unsupported Atrium references without asking the OS to open %s",
    async (reference) => {
      await expect(tryOpenExternalUrl(reference, "markdown-link")).resolves.toBe(false);
      expect(openURL).not.toHaveBeenCalled();
      expect(Alert.alert).toHaveBeenCalledWith(
        "Unsupported Atrium link",
        expect.stringContaining("Unsupported Atrium link:"),
      );
    },
  );

  it("shows a reader-opening failure instead of silently dropping the Atrium tap", async () => {
    openURL.mockRejectedValue(new Error("browser unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      tryOpenExternalUrl("uid:01900000-0000-7000-8000-000000000001", "markdown-link"),
    ).resolves.toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith(
      "Unable to open Atrium note",
      expect.stringContaining("reader"),
    );
  });

  it("opens supported URLs", async () => {
    openURL.mockResolvedValue(undefined);

    await expect(
      tryOpenExternalUrl("https://github.com/pingdotgg/t3code", "pull-request"),
    ).resolves.toBe(true);
  });

  it("logs stable URL context without exposing the opening failure", async () => {
    const cause = new Error("browser-unavailable-secret-sentinel");
    openURL.mockRejectedValue(cause);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      tryOpenExternalUrl("https://github.com/pingdotgg/t3code/pull/1?token=secret", "pull-request"),
    ).resolves.toBe(false);

    expect(consoleError).toHaveBeenCalledTimes(1);
    const [message, attributes] = consoleError.mock.calls[0] ?? [];
    expect(message).toBe("Failed to open pull-request URL with the https scheme.");
    expect(attributes).toEqual(
      expect.objectContaining({
        _tag: "ExternalUrlOpenError",
        target: "pull-request",
        scheme: "https",
        host: "github.com",
        stack: expect.stringContaining("ExternalUrlOpenError"),
      }),
    );
    expect(attributes).not.toHaveProperty("url");
    expect(attributes).not.toHaveProperty("cause");
    const diagnosticText = [message, ...Object.values(attributes as Record<string, unknown>)]
      .map(String)
      .join("\n");
    expect(diagnosticText).not.toContain("token=secret");
    expect(diagnosticText).not.toContain("browser-unavailable-secret-sentinel");
  });

  it("keeps provider sign-in URLs unchanged and out of failure logs", async () => {
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?state=private-state&code_challenge=private-challenge&redirect_uri=http%3A%2F%2F127.0.0.1%3A43123%2F";
    openURL.mockRejectedValue(new Error(`Cannot open ${url}`));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(tryOpenExternalUrl(url, "provider-auth")).resolves.toBe(false);

    expect(openURL).toHaveBeenCalledWith(url);
    const diagnostics = JSON.stringify(consoleError.mock.calls);
    expect(diagnostics).toContain("accounts.google.com");
    expect(diagnostics).not.toContain("private-state");
    expect(diagnostics).not.toContain("private-challenge");
    expect(diagnostics).not.toContain("43123");
  });
});
