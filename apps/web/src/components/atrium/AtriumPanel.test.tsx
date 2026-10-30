import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AtriumReadObjectError,
  EnvironmentId,
  ThreadId,
  type AtriumReadObjectResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const server = vi.hoisted(() => ({ readAtriumObject: vi.fn(), configValueAtom: vi.fn() }));
// Every signed asset URL the body asks for, so a test can see which authority it used.
const assets = vi.hoisted(() => ({ requested: [] as unknown[] }));
vi.mock("~/state/server", () => ({ serverEnvironment: server }));
vi.mock("~/assets/assetUrls", async (original) => ({
  ...(await original<typeof import("~/assets/assetUrls")>()),
  useAssetUrlState: (_environmentId: unknown, resource: { _tag: string; href?: string } | null) => {
    if (resource === null) return { _tag: "Loading" };
    // Renders repeat; record each resource once, in first-asked order.
    if (!assets.requested.some((seen) => JSON.stringify(seen) === JSON.stringify(resource)))
      assets.requested.push(resource);
    return {
      _tag: "Success",
      url: `https://t3.example/api/assets/signed/${encodeURIComponent(resource.href ?? "")}`,
    };
  },
  useAssetUrlRefresh: () => async () => null,
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", async (original) => {
  const actual = await original<typeof import("~/hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/browser/browserDefaults", () => ({ useBrowserDefaults: () => ({ profiles: [] }) }));
vi.mock("~/components/preview/PreviewPanelShell", () => ({
  PreviewPanelShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger: ({
      render,
      children,
    }: ComponentProps<typeof import("~/components/ui/tooltip").TooltipTrigger>) =>
      isValidElement(render) ? (
        children === undefined ? (
          render
        ) : (
          cloneElement(render, undefined, children)
        )
      ) : (
        <>{children}</>
      ),
    TooltipPopup: () => null,
  };
});

import {
  selectActiveRightPanelSurface,
  useRightPanelStore,
  type RightPanelSurface,
} from "~/rightPanelStore";
import { AtriumPanel } from "./AtriumPanel";
import { RightPanelTabs } from "../RightPanelTabs";
import { selectThreadRightPanelState } from "~/rightPanelStore";

const UID = "01900000-0000-7000-8000-000000000001";
const ref = scopeThreadRef(
  EnvironmentId.make("environment-example"),
  ThreadId.make("thread-example"),
);
const reference = `atrium://uid/${UID}?rel=review&why=Read&fallback=source`;
const object = (body = "Current **body**"): AtriumReadObjectResult => ({
  uid: UID,
  title: "Current object",
  kind: "note",
  path: "example/object.md",
  body,
});
const initialSurface: Extract<RightPanelSurface, { kind: "atrium" }> = {
  id: `atrium:${UID}`,
  kind: "atrium",
  uid: UID,
  title: "Authored label",
  reference,
  readRequestId: 1,
};
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
let renderer: ReactTestRenderer | undefined;
let registry: AtomRegistry.AtomRegistry;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  server.readAtriumObject.mockReset();
  assets.requested.length = 0;
  server.configValueAtom.mockReturnValue(Atom.make(null));
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useRightPanelStore.getState().openAtrium(ref, reference, "Authored label");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  registry.dispose();
  vi.unstubAllGlobals();
});

async function render(surface = initialSurface, threadRef = ref, visible = true) {
  await act(async () => {
    const panel = (
      <RegistryContext.Provider value={registry}>
        <AtriumPanel threadRef={threadRef} surface={surface} visible={visible} />
      </RegistryContext.Provider>
    );
    if (renderer) renderer.update(panel);
    else renderer = create(panel);
  });
}

function readHarness() {
  const requests: Array<{
    environmentId: string;
    uid: string;
    resolve: (object: AtriumReadObjectResult) => void;
  }> = [];
  const family = Atom.family((key: string) =>
    Atom.make(
      Effect.promise(
        () =>
          new Promise<AtriumReadObjectResult>((resolve) => {
            const target = JSON.parse(key) as { environmentId: string; input: { uid: string } };
            requests.push({ environmentId: target.environmentId, uid: target.input.uid, resolve });
          }),
      ),
    ).pipe(Atom.swr({ staleTime: 0, revalidateOnMount: true }), Atom.setIdleTTL(0)),
  );
  server.readAtriumObject.mockImplementation((target) => family(JSON.stringify(target)));
  return requests;
}

describe("AtriumPanel current-object reads", () => {
  it("uses current-titled Atrium tabs whose close action restores the peer surface and can reopen", async () => {
    server.readAtriumObject.mockReturnValue(Atom.make(Effect.succeed(object())));
    const store = useRightPanelStore.getState();
    store.open(ref, "diff");
    store.openAtrium(ref, reference, "Authored label");
    function Workspace() {
      const state = useRightPanelStore((state) =>
        selectThreadRightPanelState(state.byThreadKey, ref),
      );
      const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
      return (
        <RightPanelTabs
          mode="embedded"
          surfaces={state.surfaces}
          activeSurfaceId={state.activeSurfaceId}
          environmentId={ref.environmentId}
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          desktopByTabId={{}}
          terminalLabelsById={new Map()}
          onActivate={(surface) => store.activateSurface(ref, surface.id)}
          onCloseSurface={(surface) => store.closeSurface(ref, surface.id)}
          onCloseOtherSurfaces={(surface) => store.closeOtherSurfaces(ref, surface.id)}
          onCloseSurfacesToRight={(surface) => store.closeSurfacesToRight(ref, surface.id)}
          onCloseAllSurfaces={() => store.closeAllSurfaces(ref)}
          onCopyFilePath={() => {}}
          onAddBrowser={() => {}}
          onAddBrowserInProfile={() => {}}
          onAddTerminal={() => {}}
          onAddDiff={() => {}}
          onAddFiles={() => {}}
          onAddPullRequest={() => {}}
          onAddPullRequests={() => {}}
          onAddDevice={() => {}}
          browserAvailable={false}
          terminalAvailable={false}
          diffAvailable
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          deviceAvailable={false}
        >
          {active?.kind === "atrium" ? (
            <AtriumPanel threadRef={ref} surface={active} visible={state.isOpen} />
          ) : (
            <div>Peer diff surface</div>
          )}
        </RightPanelTabs>
      );
    }
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <Workspace />
        </RegistryContext.Provider>,
      );
    });
    const close = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Close Current object");
    expect(close).toBeDefined();
    expect(
      renderer!.root
        .findAllByType("button")
        .filter((button) => button.props["aria-label"] === "Close Current object"),
    ).toHaveLength(1);
    await act(async () => close!.props.onClick());
    expect(text(renderer!.root)).toContain("Peer diff surface");
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref)?.kind,
    ).toBe("diff");
    await act(async () => store.openAtrium(ref, reference));
    expect(text(renderer!.root.findByType("h1"))).toBe("Current object");
  });

  it("shows loading then current native Markdown, projection metadata and canonical context copy", async () => {
    const requests = readHarness();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await render();
    expect(requests.map(({ environmentId, uid }) => ({ environmentId, uid }))).toEqual([
      { environmentId: ref.environmentId, uid: UID },
    ]);
    expect(text(renderer!.root)).toContain("Loading Atrium object");
    await act(async () => requests[0]!.resolve(object()));
    expect(text(renderer!.root.findByType("h1"))).toBe("Current object");
    expect(text(renderer!.root.findByType("strong"))).toBe("body");
    expect(text(renderer!.root)).toContain("example/object.md");
    expect(text(renderer!.root)).toContain(UID);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({ title: "Current object" });
    const copy = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Copy Atrium context link")!;
    await act(async () => copy.props.onClick());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(reference);
    const alternative = renderer!.root
      .findAllByType("a")
      .find((link) => text(link).includes("estate reader"))!;
    expect(new URL(alternative.props.href).searchParams.get("note")).toBe(UID);
    expect(renderer!.root.findAllByType("iframe")).toHaveLength(0);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => /close/i.test(button.props["aria-label"] ?? "")),
    ).toBe(false);
  });

  it("reads once initially, refreshes repeated opens, and rereads after hiding/reopening", async () => {
    const requests = readHarness();
    await render();
    expect(requests).toHaveLength(1);
    await act(async () => requests[0]!.resolve(object("First version")));
    await render({
      ...initialSurface,
      readRequestId: 2,
      reference: `atrium://uid/${UID}?why=Again`,
    });
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]!.resolve(object("Second version")));
    expect(text(renderer!.root)).toContain("Second version");
    await render({ ...initialSurface, readRequestId: 2 });
    expect(requests).toHaveLength(2);
    await render(initialSurface, ref, false);
    await render();
    expect(requests).toHaveLength(3);
    await act(async () => requests[2]!.resolve(object("Reopened version")));
    expect(text(renderer!.root)).toContain("Reopened version");
  });

  it("does not display another environment's in-flight or prior object", async () => {
    const requests = readHarness();
    await render();
    const otherRef = scopeThreadRef(EnvironmentId.make("other-environment"), ref.threadId);
    await render(initialSurface, otherRef);
    expect(requests.map((request) => request.environmentId)).toEqual([
      ref.environmentId,
      otherRef.environmentId,
    ]);
    await act(async () => requests[0]!.resolve(object("Old environment")));
    expect(text(renderer!.root)).not.toContain("Old environment");
    await act(async () => requests[1]!.resolve(object("Selected environment")));
    expect(text(renderer!.root)).toContain("Selected environment");
  });

  it.each([
    ["not-found", "Atrium object not found"],
    ["unavailable", "Atrium Service unavailable"],
    ["invalid-response", "Invalid Atrium response"],
  ] as const)(
    "reports %s and retry replaces the failure with the current body",
    async (reason, message) => {
      let failed = true;
      const read = vi.fn(() =>
        failed
          ? Effect.fail(new AtriumReadObjectError({ uid: UID, reason }))
          : Effect.succeed(object("Recovered body")),
      );
      const atom = Atom.make(Effect.suspend(read));
      server.readAtriumObject.mockReturnValue(atom);
      await render();
      expect(text(renderer!.root.findByProps({ role: "alert" }))).toContain(message);
      failed = false;
      const retry = renderer!.root
        .findAllByType("button")
        .find((button) => text(button) === "Try again")!;
      await act(async () => retry.props.onClick());
      expect(text(renderer!.root)).toContain("Recovered body");
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it("opens a nested Atrium link in the same app scope and keeps local paths out of the workspace", async () => {
    const body = `[Nested](atrium://uid/${UID}){why="Nested context"}\n\n[Local](/tmp/object.md)\n\n![Image](/tmp/image.png)\n\n- [ ] Read only`;
    server.readAtriumObject.mockReturnValue(Atom.make(Effect.succeed(object(body))));
    await render();
    expect(renderer!.root.findByType("input").props.disabled).toBe(true);
    const nested = renderer!.root
      .findAllByType("a")
      .find((link) => link.props["data-atrium-reference"])!;
    await act(async () =>
      nested.props.onClick({ button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() }),
    );
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref),
    ).toMatchObject({
      kind: "atrium",
      reference: `atrium://uid/${UID}?why=Nested+context`,
      readRequestId: 2,
    });
    expect(
      renderer!.root.findAllByType("a").some((link) => link.props.href === "/tmp/object.md"),
    ).toBe(false);
    // Local destinations never reach the workspace or host files: they are the object's own
    // files, which only Atrium Service resolves (and serves only when the object references them).
    expect(assets.requested).toEqual([
      { _tag: "atrium-file", uid: UID, href: "/tmp/object.md" },
      { _tag: "atrium-file", uid: UID, href: "/tmp/image.png" },
    ]);
  });

  it("loads a note's relative image and file links through Atrium Service, anchored to the object", async () => {
    const body = [
      "## Saved receipt",
      "",
      "![Cropped receipt](assets/bundle/receipt_cropped.png)",
      "",
      "- [Cropped receipt PDF](assets/bundle/receipt.pdf)",
      "- [Full-bed scan](<assets/bundle/scan full bed.png>)",
      "- [Manifest](../index.json)",
      "- [Back to top](#saved-receipt)",
      "- [Elsewhere](https://example.com/receipt)",
    ].join("\n");
    server.readAtriumObject.mockReturnValue(Atom.make(Effect.succeed(object(body))));
    await render();
    expect(assets.requested).toEqual(
      expect.arrayContaining([
        { _tag: "atrium-file", uid: UID, href: "assets/bundle/receipt_cropped.png" },
        { _tag: "atrium-file", uid: UID, href: "assets/bundle/receipt.pdf" },
        { _tag: "atrium-file", uid: UID, href: "assets/bundle/scan%20full%20bed.png" },
        { _tag: "atrium-file", uid: UID, href: "../index.json" },
      ]),
    );
    // Anchors and web links are not object files and keep their own behavior.
    expect(
      assets.requested.every((resource) => (resource as { _tag: string })._tag === "atrium-file"),
    ).toBe(true);
    expect(assets.requested).toHaveLength(4);
    const links = renderer!.root.findAllByType("a");
    const pdf = links.find((link) => text(link) === "Cropped receipt PDF")!;
    expect(pdf.props.href).toBe(
      `https://t3.example/api/assets/signed/${encodeURIComponent("assets/bundle/receipt.pdf")}`,
    );
    expect(pdf.props.target).toBe("_blank");
    expect(links.find((link) => text(link) === "Back to top")!.props.href).toBe("#saved-receipt");
    expect(links.find((link) => text(link) === "Elsewhere")!.props.href).toBe(
      "https://example.com/receipt",
    );
    const image = renderer!.root
      .findAllByType("img")
      .find((img) => img.props.alt === "Cropped receipt");
    expect(image?.props.src).toBe(
      `https://t3.example/api/assets/signed/${encodeURIComponent("assets/bundle/receipt_cropped.png")}`,
    );
  });
});
