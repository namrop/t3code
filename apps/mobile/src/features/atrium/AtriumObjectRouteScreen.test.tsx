import { RegistryContext } from "@effect/atom-react";
import { NavigationContext } from "@react-navigation/native";
import {
  AtriumReadObjectError,
  EnvironmentId,
  type AtriumReadObjectResult,
} from "@t3tools/contracts";
import { parseAtriumLink } from "@t3tools/client-runtime/atrium-links";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { act, type ReactNode } from "react";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Linking } from "react-native";
import { createReactProbe } from "../../lib/testing/reactProbe";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../state/server";
import { AtriumObjectRouteScreen } from "./AtriumObjectRouteScreen";
import type { ScreenHeaderProps } from "../../components/ScreenHeader.types";
import type { FileMarkdownPreview } from "../files/FileMarkdownPreview";

const ui = vi.hoisted(() => ({
  header: null as ScreenHeaderProps | null,
  markdown: null as Parameters<typeof FileMarkdownPreview>[0] | null,
  error: null as { title: string; detail: string; onAction?: () => void } | null,
  loading: "",
  headers: new Map<string, ScreenHeaderProps>(),
  bodies: new Map<string, string>(),
  back: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => children ?? null,
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
}));
vi.mock("@react-navigation/native", async () => {
  const { createContext, useContext } = await import("react");
  const NavigationContext = createContext<{
    getId: () => string;
    isFocused: () => boolean;
    goBack: () => void;
  } | null>(null);
  return {
    NavigationContext,
    useNavigation: () => useContext(NavigationContext) ?? { goBack: ui.back },
    useIsFocused: () => useContext(NavigationContext)?.isFocused() ?? true,
  };
});
vi.mock("../../components/ScreenHeader", async () => {
  const { useContext } = await import("react");
  return {
    ScreenHeader: (props: ScreenHeaderProps) => {
      const navigation = useContext(NavigationContext);
      ui.header = props;
      const key = navigation?.getId();
      if (key) ui.headers.set(key, props);
      return null;
    },
  };
});
vi.mock("../../components/EmptyState", () => ({
  EmptyState: (props: NonNullable<typeof ui.error>) => {
    ui.error = props;
    return null;
  },
}));
vi.mock("../files/FilePreviewFeedback", () => ({
  FilePreviewLoading: ({ message }: { message: string }) => {
    ui.loading = message;
    return null;
  },
}));
vi.mock("../files/FileMarkdownPreview", async () => {
  const { useContext } = await import("react");
  return {
    FileMarkdownPreview: (props: Parameters<typeof FileMarkdownPreview>[0]) => {
      const navigation = useContext(NavigationContext);
      ui.markdown = props;
      const key = navigation?.getId();
      if (key) ui.bodies.set(key, props.markdown ?? "");
      return null;
    },
  };
});
vi.mock("../../lib/copyTextWithHaptic", () => ({ copyTextWithHaptic: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: { readAtriumObject: vi.fn() } }));

const uid = "01900000-0000-7000-8000-000000000001";
const reference = `uid:${uid}?rel=source&why=Read+first&fallback=url%3Ahttps%3A%2F%2Fexample.com`;
const object: AtriumReadObjectResult = {
  uid,
  title: "Example note",
  path: "example/note.md",
  kind: "note",
  body: `# Example\n\n[Related](atrium://uid/${uid}){why="Nested"}`,
};
let probe: ReturnType<typeof createReactProbe>;
let registry: AtomRegistry.AtomRegistry;
let response: AsyncResult.AsyncResult<AtriumReadObjectResult, AtriumReadObjectError>;
let reads: number;

beforeEach(() => {
  probe = createReactProbe();
  registry = AtomRegistry.make();
  response = AsyncResult.initial(true);
  reads = 0;
  ui.header = null;
  ui.markdown = null;
  ui.error = null;
  ui.loading = "";
  ui.headers.clear();
  ui.bodies.clear();
  vi.clearAllMocks();
  const atom = Atom.make(() => {
    reads += 1;
    return response;
  });
  vi.mocked(serverEnvironment.readAtriumObject).mockReturnValue(atom);
});
afterEach(async () => {
  await probe.dispose();
  registry.dispose();
});
async function render(ref = reference) {
  await probe.render(
    <RegistryContext.Provider value={registry}>
      <AtriumObjectRouteScreen
        route={{
          params: { environmentId: "environment-1", threadId: "thread-1", reference: ref },
        }}
      />
    </RegistryContext.Provider>,
  );
}

/** Real query-family stale/TTL behavior with a synthetic Service boundary. */
function currentObjectReader() {
  let generation = 1;
  const requests: string[] = [];
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry.EnvironmentRegistry,
      Effect.gen(function* () {
        const session: RpcSession = {
          client: {} as WsRpcProtocolClient,
          initialConfig: Effect.never,
          subscribeServerConfig: () => Stream.empty,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId: EnvironmentId.make("environment-1"),
            label: "Test environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected",
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        return EnvironmentRegistry.EnvironmentRegistry.of({
          run: (_environmentId, effect) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          followStream: (_environmentId, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      }),
    ),
  );
  const read = createEnvironmentQueryAtomFamily(runtime, {
    label: "mobile-test:atrium-object",
    staleTimeMs: 0,
    idleTtlMs: 0,
    execute: ({ uid }: { uid: string }) =>
      Effect.promise(async () => {
        requests.push(uid);
        return { ...object, uid, body: `Generation ${generation}` };
      }),
  });
  vi.mocked(serverEnvironment.readAtriumObject).mockImplementation(read);
  return {
    requests,
    setGeneration: (next: number) => {
      generation = next;
    },
  };
}

async function renderStack(screens: readonly { key: string; uid: string }[]) {
  const entries = screens.map((screen, index) => ({
    screen,
    navigation: {
      getId: () => screen.key,
      isFocused: () => index === screens.length - 1,
      goBack: () => {
        void renderStack(screens.slice(0, -1));
      },
    },
  }));
  await probe.render(
    <RegistryContext.Provider value={registry}>
      {entries.map(({ screen, navigation }) => (
        <NavigationContext.Provider key={screen.key} value={navigation as never}>
          <AtriumObjectRouteScreen
            route={{
              params: {
                environmentId: "environment-1",
                threadId: "thread-1",
                reference: `uid:${screen.uid}`,
              },
            }}
          />
        </NavigationContext.Provider>
      ))}
    </RegistryContext.Provider>,
  );
}

describe("AtriumObjectRouteScreen", () => {
  it("reads fresh A after nested A→B→A pushes and back to the retained A", async () => {
    const reader = currentObjectReader();
    const a = { key: "a", uid };
    const b = { key: "b", uid: "01900000-0000-7000-8000-000000000002" };
    const nestedA = { key: "nested-a", uid };
    await renderStack([a]);
    expect(reader.requests).toEqual([uid]);
    expect(ui.bodies.get("a")).toBe("Generation 1");
    await renderStack([a, b]);
    expect(reader.requests).toEqual([uid, b.uid]);
    reader.setGeneration(2);
    await renderStack([a, b, nestedA]);
    expect(ui.bodies.get("nested-a")).toBe("Generation 2");
    expect(reader.requests).toEqual([uid, b.uid, uid]);
    await act(async () => ui.headers.get("nested-a")?.onBack?.());
    expect(reader.requests).toEqual([uid, b.uid, uid, b.uid]);
    await act(async () => ui.headers.get("b")?.onBack?.());
    expect(ui.bodies.get("a")).toBe("Generation 2");
    expect(reader.requests).toEqual([uid, b.uid, uid, b.uid, uid]);
  });

  it("does not read a covered retained screen, and reads it once when focused", async () => {
    const reader = currentObjectReader();
    const a = { key: "a", uid };
    const b = { key: "b", uid: "01900000-0000-7000-8000-000000000002" };
    await renderStack([a, b]);
    expect(reader.requests).toEqual([b.uid]);
    await act(async () => ui.headers.get("b")?.onBack?.());
    expect(reader.requests).toEqual([b.uid, uid]);
    expect(ui.bodies.get("a")).toBe("Generation 1");
  });

  it("reads fresh content when the same UID is pushed directly over itself and popped", async () => {
    const reader = currentObjectReader();
    const a = { key: "a", uid };
    const nestedA = { key: "nested-a", uid };
    await renderStack([a]);
    expect(reader.requests).toEqual([uid]);
    reader.setGeneration(2);
    await renderStack([a, nestedA]);
    expect(ui.bodies.get("nested-a")).toBe("Generation 2");
    expect(reader.requests).toEqual([uid, uid]);
    reader.setGeneration(3);
    await act(async () => ui.headers.get("nested-a")?.onBack?.());
    expect(ui.bodies.get("a")).toBe("Generation 3");
    expect(reader.requests).toEqual([uid, uid, uid]);
  });

  it("requests only the UID in the correct environment and shows loading", async () => {
    await render();
    expect(serverEnvironment.readAtriumObject).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { uid },
    });
    expect(ui.loading).toBe("Loading Atrium object...");
    expect(ui.markdown).toBeNull();
  });

  it("renders the exact body with scoped native Markdown and metadata", async () => {
    response = AsyncResult.success(object);
    await render();
    expect(ui.header).toMatchObject({ title: object.title, subtitle: "example/note.md · note" });
    expect(ui.markdown).toMatchObject({
      markdown: object.body,
      captured: true,
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    ui.header?.onBack?.();
    expect(ui.back).toHaveBeenCalledOnce();
  });

  it.each(["not-found", "unavailable", "invalid-response"] as const)(
    "shows an explicit %s failure and retries the query",
    async (reason) => {
      response = AsyncResult.failure(Cause.fail(new AtriumReadObjectError({ uid, reason })));
      await render();
      expect(ui.error?.title).toBe("Unable to read Atrium object");
      expect(ui.error?.detail).toBe(new AtriumReadObjectError({ uid, reason }).message);
      expect(ui.markdown).toBeNull();
      response = AsyncResult.success(object);
      await act(() => ui.error?.onAction?.());
      expect(reads).toBe(2);
      expect(ui.markdown?.markdown).toBe(object.body);
    },
  );

  it.each(["atrium://beam/example", "atrium://uid/not-a-uid", `uid:${uid}?revision=1`])(
    "rejects unsupported references before requesting: %s",
    async (ref) => {
      await render(ref);
      expect(serverEnvironment.readAtriumObject).not.toHaveBeenCalled();
      expect(ui.error?.title).toBe("Unsupported Atrium link");
      expect(ui.error?.detail).toContain("Unsupported Atrium link:");
    },
  );

  it.each([`uid:${uid}`, `UID:${uid}`, `atrium://uid/${uid}`])(
    "copies canonical identity with intact context from %s, with explicit estate fallback",
    async (locator) => {
      response = AsyncResult.success({ ...object, kind: null });
      const suffix = "?rel=source&why=Read+first&fallback=url%3Ahttps%3A%2F%2Fexample.com";
      await render(locator + suffix);
      expect(Linking.openURL).not.toHaveBeenCalled();
      const items = ui.header?.menus?.[0]?.items ?? [];
      const copy = items.find((item) => item.id === "copy-link");
      if (copy && "onPress" in copy) copy.onPress();
      expect(copyTextWithHaptic).toHaveBeenCalledExactlyOnceWith(`atrium://uid/${uid}${suffix}`, {
        target: "Atrium link",
      });
      const copied = vi.mocked(copyTextWithHaptic).mock.calls[0]?.[0];
      expect(parseAtriumLink(copied ?? "")).toMatchObject({
        kind: "object",
        uid,
        rel: "source",
        why: "Read first",
        fallback: "url:https://example.com",
      });
      const external = items.find((item) => item.id === "open-reader");
      if (external && "onPress" in external) external.onPress();
      expect(Linking.openURL).toHaveBeenCalledExactlyOnceWith(
        `https://atrium.sol.pharos.zone/?note=${uid}&rel=source&why=Read+first&fallback=url%3Ahttps%3A%2F%2Fexample.com`,
      );
    },
  );
});
