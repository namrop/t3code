import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useLayoutEffect } from "react";
import { normalizeAtriumMarkdown } from "@t3tools/client-runtime/atrium-links";
import { NavigationContext, StackActions } from "@react-navigation/native";
import { Linking } from "react-native";
import { createReactProbe } from "./testing/reactProbe";
import { useMarkdownLinkOpener } from "./useMarkdownLinkOpener";

vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  return {
    NavigationContext: createContext(undefined),
    StackActions: {
      push: (name: string, params: unknown) => ({ type: "PUSH", payload: { name, params } }),
    },
  };
});
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, Linking: { openURL: vi.fn() } }));

let probe: ReturnType<typeof createReactProbe>;
let open: (href: string) => void;
const dispatch = vi.fn();
const navigation = { dispatch } as never;
const uid = "01900000-0000-7000-8000-000000000001";
function Probe(props: { environmentId?: string; threadId?: string | null }) {
  const opener = useMarkdownLinkOpener(props);
  useLayoutEffect(() => {
    open = opener;
  }, [opener]);
  return null;
}
beforeEach(() => {
  probe = createReactProbe();
  vi.clearAllMocks();
});
afterEach(async () => {
  await probe.dispose();
});

async function scoped(threadId?: string) {
  await probe.render(
    <NavigationContext.Provider value={navigation}>
      <Probe environmentId="environment-1" threadId={threadId} />
    </NavigationContext.Provider>,
  );
}

describe("useMarkdownLinkOpener", () => {
  it("pushes normalized body context and nested objects onto the native back stack", async () => {
    await scoped("thread-1");
    const markdown = normalizeAtriumMarkdown(
      `[Note](atrium://uid/${uid}){rel="source" why="Read this first" fallback="url:https://example.com"}`,
    );
    const href = markdown.slice(markdown.indexOf("(") + 1, -1);
    open(href);
    open(`uid:${uid}?why=Nested`);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      StackActions.push("AtriumObject", {
        environmentId: "environment-1",
        threadId: "thread-1",
        reference: href,
      }),
      StackActions.push("AtriumObject", {
        environmentId: "environment-1",
        threadId: "thread-1",
        reference: `uid:${uid}?why=Nested`,
      }),
    ]);
    expect(Linking.openURL).not.toHaveBeenCalled();
  });

  it("opens a scoped draft reference without manufacturing a thread", async () => {
    await scoped();
    open(`uid:${uid}`);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      StackActions.push("AtriumObject", {
        environmentId: "environment-1",
        reference: `uid:${uid}`,
      }),
    );
  });

  it("preserves the estate-reader fallback for a genuinely unscoped caller", async () => {
    await probe.render(<Probe />);
    open(`uid:${uid}`);
    expect(dispatch).not.toHaveBeenCalled();
    expect(Linking.openURL).toHaveBeenCalledExactlyOnceWith(
      `https://atrium.sol.pharos.zone/?note=${uid}`,
    );
  });
});
