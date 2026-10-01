import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  hermesAcceptsAudioPrompts,
  hermesAudioMimeType,
  HERMES_TERMINAL_AUTH_METHOD_ID,
  isHermesAudioAttachment,
  resolveHermesAcpBaseModelId,
  resolveHermesAcpModeId,
} from "./HermesAcpSupport.ts";

describe("isHermesAudioAttachment", () => {
  const file = (name: string, mimeType: string) => ({ type: "file" as const, name, mimeType });

  it("treats audio MIME types as voice notes", () => {
    expect(isHermesAudioAttachment(file("note.m4a", "audio/mp4"))).toBe(true);
    expect(isHermesAudioAttachment(file("note.webm", "audio/webm;codecs=opus"))).toBe(true);
    expect(isHermesAudioAttachment(file("Recording.mp3", "AUDIO/MPEG"))).toBe(true);
  });

  it("falls back to audio-only extensions when the picker gives no audio type", () => {
    expect(isHermesAudioAttachment(file("Recording 12.m4a", "application/octet-stream"))).toBe(
      true,
    );
    expect(isHermesAudioAttachment(file("memo.OGG", "application/octet-stream"))).toBe(true);
  });

  it("leaves video, documents and images alone", () => {
    expect(isHermesAudioAttachment(file("clip.mp4", "video/mp4"))).toBe(false);
    expect(isHermesAudioAttachment(file("clip.webm", "application/octet-stream"))).toBe(false);
    expect(isHermesAudioAttachment(file("notes.txt", "text/plain"))).toBe(false);
    expect(isHermesAudioAttachment({ type: "image", name: "a.png", mimeType: "image/png" })).toBe(
      false,
    );
  });
});

describe("hermesAudioMimeType", () => {
  it("keeps the picker's audio type and derives one from the extension otherwise", () => {
    expect(hermesAudioMimeType({ name: "a.webm", mimeType: "audio/webm;codecs=opus" })).toBe(
      "audio/webm;codecs=opus",
    );
    expect(
      hermesAudioMimeType({ name: "Recording.m4a", mimeType: "application/octet-stream" }),
    ).toBe("audio/mp4");
    expect(hermesAudioMimeType({ name: "memo.ogg", mimeType: "" })).toBe("audio/ogg");
  });
});

describe("hermesAcceptsAudioPrompts", () => {
  it("is true only when Hermes declares promptCapabilities.audio", () => {
    expect(
      hermesAcceptsAudioPrompts({
        agentCapabilities: { promptCapabilities: { image: true, audio: true } },
      }),
    ).toBe(true);
    expect(
      hermesAcceptsAudioPrompts({
        agentCapabilities: { promptCapabilities: { image: true } },
      }),
    ).toBe(false);
    expect(hermesAcceptsAudioPrompts({})).toBe(false);
  });
});

describe("resolveHermesAcpBaseModelId", () => {
  it("normalizes empty and custom Hermes model ids", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBe("hermes-agent");
    expect(resolveHermesAcpBaseModelId("   ")).toBe("hermes-agent");
    expect(resolveHermesAcpBaseModelId("  anthropic:claude-opus-4-8  ")).toBe(
      "anthropic:claude-opus-4-8",
    );
  });
});

describe("resolveHermesAcpModeId", () => {
  it("maps Full access to dont_ask", () => {
    expect(resolveHermesAcpModeId("full-access")).toBe("dont_ask");
  });

  it("maps Auto-accept edits to accept_edits", () => {
    expect(resolveHermesAcpModeId("auto-accept-edits")).toBe("accept_edits");
  });

  it("maps Auto to dont_ask so Hermes's own judgment decides, not a prompt per edit", () => {
    expect(resolveHermesAcpModeId("auto")).toBe("dont_ask");
  });

  it("maps Supervised to supervised so commands ask too, not only edits", () => {
    expect(resolveHermesAcpModeId("approval-required")).toBe("supervised");
  });

  it("maps an unset runtime mode to default", () => {
    expect(resolveHermesAcpModeId(undefined)).toBe("default");
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("spawns `<binary> acp` with no runtime-mode-dependent argv", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes", homePath: "" },
      "/tmp/project",
      {
        PATH: "/usr/bin",
      },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { PATH: "/usr/bin" },
    });
  });

  it("falls back to the `hermes` binary name when binaryPath is empty", () => {
    const spawn = buildHermesAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.command).toBe("hermes");
    expect(spawn.args).toEqual(["acp"]);
  });

  it("does not pass an inherited HERMES_HOME through in place of the setting", () => {
    const inherited = { PATH: "/usr/bin", HERMES_HOME: "/srv/inherited-home" };

    const blank = buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "" },
      "/tmp/project",
      inherited,
    );
    expect(blank.env).toEqual({ PATH: "/usr/bin" });

    const set = buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "/srv/chosen-home" },
      "/tmp/project",
      inherited,
    );
    expect(set.env).toEqual({ PATH: "/usr/bin", HERMES_HOME: "/srv/chosen-home" });
  });

  it("sets HERMES_HOME only when homePath is non-empty", () => {
    const withHome = buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "~/.hermes/profiles/phoebe" },
      "/tmp/project",
    );
    expect(withHome.env).toEqual({ HERMES_HOME: "~/.hermes/profiles/phoebe" });

    const withoutHome = buildHermesAcpSpawnInput(
      { binaryPath: "hermes", homePath: "" },
      "/tmp/project",
    );
    expect(withoutHome.env).toEqual({});
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: string[] = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: "anthropic:claude-sonnet-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["anthropic:claude-sonnet-5"]);
      expect(result).toBe("anthropic:claude-sonnet-5");
    }),
  );

  it.effect("skips set_model when requested matches current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: "anthropic:claude-opus-4-8",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic:claude-opus-4-8");
    }),
  );

  it.effect("keeps the session's current model when the placeholder slug is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: "hermes-agent",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic:claude-opus-4-8");
    }),
  );

  it.effect("skips set_model when no model is requested", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "anthropic:claude-opus-4-8",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("anthropic:claude-opus-4-8");
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("session id not known");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "anthropic:claude-opus-4-8",
          requestedModelId: "anthropic:claude-sonnet-5",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("HERMES_TERMINAL_AUTH_METHOD_ID", () => {
  it("is the documented fallback terminal auth method id", () => {
    expect(HERMES_TERMINAL_AUTH_METHOD_ID).toBe("hermes-setup");
  });
});
