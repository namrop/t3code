import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChatAttachmentId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { refresh, assetReads, projectFileQuery } = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<string | null>>(),
  assetReads: vi.fn(() => ({ _tag: "Failure" })),
  projectFileQuery: vi.fn(() => ({
    data: null,
    error: null,
    isPending: false,
    isNotFile: false,
    refresh: vi.fn(),
  })),
}));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: () => refresh,
  useAssetUrlState: assetReads,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", async (original) => {
  const actual = await original<typeof import("~/hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
    useUpdateClientSettings: () => vi.fn(),
  };
});
vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => null,
  setLocalStorageItem: vi.fn(),
  useLocalStorage: (_key: string, initial: boolean) => [initial, vi.fn()],
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => null,
}));
vi.mock("~/state/session", async (original) => ({
  ...(await original<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenState: () => ({ mode: "local-exec" }),
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
vi.mock("./projectFilesQueryState", async (original) => ({
  ...(await original<typeof import("./projectFilesQueryState")>()),
  useProjectFileQuery: projectFileQuery,
}));
vi.mock("./FileBrowserPanel", () => ({ default: () => null }));
vi.mock("~/components/DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));

import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import FilePreviewPanel from "./FilePreviewPanel";

const threadRef = scopeThreadRef(
  EnvironmentId.make("attachment-environment"),
  ThreadId.make("attachment-thread"),
);
const uid = "01900000-0000-7000-8000-000000000001";
const markdown = `[Object](uid:${uid}){why="Read captured context"}\n\n[Local](/tmp/object.md)\n\n\u0060/tmp/object.md\u0060\n\n![Local image](/tmp/image.png)\n\n[External](https://example.com/docs)`;
const attachment = {
  type: "file" as const,
  id: ChatAttachmentId.make("captured-markdown"),
  name: "captured.md",
  mimeType: "text/markdown",
  sizeBytes: new TextEncoder().encode(markdown).byteLength,
};
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  refresh.mockReset().mockResolvedValue("https://environment.test/captured.md");
  assetReads.mockClear();
  projectFileQuery.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(markdown)),
  );
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("captured attachment Atrium navigation", () => {
  it("opens a thread-owned file-panel attachment in the native panel without workspace authority", async () => {
    await act(async () => {
      renderer = create(
        <FilePreviewPanel
          environmentId={threadRef.environmentId}
          cwd="/tmp/project"
          projectName="Project"
          relativePath="captured.md"
          attachment={attachment}
          threadRef={threadRef}
          composerDraftTarget={threadRef}
          keybindings={[]}
          availableEditors={[]}
          revealLine={null}
          revealRequestId={0}
          onOpenFile={vi.fn()}
          onPendingChange={vi.fn()}
          selectedFilePending={false}
          workspaceMutationId={null}
        />,
      );
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://environment.test/captured.md",
      expect.any(Object),
    );
    const links = renderer!.root.findAllByType("a");
    const native = links.find((link) => link.props["data-atrium-reference"])!;
    expect(native.props.href).toMatch(/^https:\/\//);
    const event = { button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => native.props.onClick(event));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      kind: "atrium",
      uid,
      reference: `uid:${uid}?why=Read+captured+context`,
    });
    expect(links.some((link) => link.props.href === "https://example.com/docs")).toBe(true);
    expect(links.some((link) => link.props.href === "/tmp/object.md")).toBe(false);
    expect(renderer!.root.findAllByProps({ "data-markdown-file-link": "" })).toHaveLength(0);
    expect(assetReads).not.toHaveBeenCalled();
    expect(projectFileQuery).toHaveBeenCalledWith(
      threadRef.environmentId,
      "/tmp/project",
      "captured.md",
      false,
    );
  });

  it("retains the browser escape for an unscoped or draft attachment", async () => {
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name={attachment.name}
          mimeType={attachment.mimeType}
          sizeBytes={attachment.sizeBytes}
          asset={{ environmentId: threadRef.environmentId, attachmentId: attachment.id }}
          origin="Draft"
        />,
      );
    });
    const native = renderer!.root
      .findAllByType("a")
      .find((link) => link.props["data-atrium-reference"])!;
    const event = { button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    await act(async () => native.props.onClick(event));
    expect(new URL(native.props.href).searchParams.get("note")).toBe(uid);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toBeNull();
    expect(renderer!.root.findAllByProps({ "data-markdown-file-link": "" })).toHaveLength(0);
    expect(assetReads).not.toHaveBeenCalled();
  });
});
