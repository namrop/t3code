import type { CustomRenderers } from "react-native-nitro-markdown";
import type { SelectableMarkdownTextProps } from "@t3tools/mobile-markdown-text/types";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { NavigationContext } from "@react-navigation/native";
import { type ReactNode } from "react";
import { Linking } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { normalizeAtriumMarkdown } from "@t3tools/client-runtime/atrium-links";
import { createReactProbe } from "../../lib/testing/reactProbe";
import { FileMarkdownPreview } from "./FileMarkdownPreview";

const ui = vi.hoisted(() => ({
  native: true,
  tap: null as (() => void) | null,
  href: "",
  dispatch: vi.fn(),
}));
vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  return {
    NavigationContext: createContext(undefined),
    StackActions: {
      push: (name: string, params: unknown) => ({ type: "PUSH", payload: { name, params } }),
    },
  };
});
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => children ?? null,
  ScrollView: ({ children }: { children?: ReactNode }) => children ?? null,
  RefreshControl: () => null,
  Text: (props: { onPress?: () => void }) => {
    ui.tap = props.onPress ?? null;
    return null;
  },
  Linking: { openURL: vi.fn() },
  Alert: { alert: vi.fn() },
}));
vi.mock("react-native-nitro-markdown", () => ({
  Markdown: ({ renderers }: { renderers: CustomRenderers }) =>
    renderers.link?.({ href: ui.href, children: null } as never) ?? null,
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  hasNativeSelectableMarkdownText: () => ui.native,
  SelectableMarkdownText: (props: SelectableMarkdownTextProps) => {
    ui.tap = () => props.onLinkPress?.(ui.href);
    return null;
  },
}));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 16 } }),
}));
vi.mock("../threads/ThreadMarkdownImage", () => ({
  ThreadMarkdownImage: () => null,
  ThreadMarkdownImageUnavailable: () => null,
}));

let probe: ReturnType<typeof createReactProbe>;
const uid = "01900000-0000-7000-8000-000000000001";
const markdown = `[Note](atrium://uid/${uid}){rel="source" why="Read this first"}`;
const navigation = { dispatch: ui.dispatch } as never;
beforeEach(() => {
  probe = createReactProbe();
  ui.tap = null;
  vi.clearAllMocks();
});
afterEach(async () => {
  await probe.dispose();
});

async function render(native: boolean, threadId: ThreadId | null = ThreadId.make("thread-1")) {
  ui.native = native;
  const normalized = normalizeAtriumMarkdown(markdown);
  ui.href = normalized.slice(normalized.indexOf("(") + 1, -1);
  await probe.render(
    <NavigationContext.Provider value={navigation}>
      <FileMarkdownPreview
        cwd="/workspace"
        relativePath="example/note.md"
        markdown={markdown}
        environmentId={EnvironmentId.make("environment-1")}
        threadId={threadId}
      />
    </NavigationContext.Provider>,
  );
}

describe("FileMarkdownPreview Atrium navigation", () => {
  it.each([true, false])(
    "keeps object links inside T3 for native selectable=%s",
    async (native) => {
      await render(native);
      ui.tap?.();
      expect(ui.dispatch).toHaveBeenCalledExactlyOnceWith({
        type: "PUSH",
        payload: {
          name: "AtriumObject",
          params: { environmentId: "environment-1", threadId: "thread-1", reference: ui.href },
        },
      });
      expect(Linking.openURL).not.toHaveBeenCalled();
    },
  );

  it("retains environment scope for a project draft preview", async () => {
    await render(true, null);
    ui.tap?.();
    expect(ui.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "PUSH",
      payload: {
        name: "AtriumObject",
        params: { environmentId: "environment-1", reference: ui.href },
      },
    });
  });

  it.each([true, false])(
    "leaves ordinary mail URLs unchanged for native selectable=%s",
    async (native) => {
      await render(native);
      ui.href = "mailto:hello@example.com";
      // Native href belongs to the text run; fallback href belongs to its rendered node.
      await probe.render(
        <NavigationContext.Provider value={navigation}>
          <FileMarkdownPreview
            cwd="/workspace"
            relativePath="example/note.md"
            markdown="[Email](mailto:hello@example.com)"
            environmentId={EnvironmentId.make("environment-1")}
            threadId={ThreadId.make("thread-1")}
          />
        </NavigationContext.Provider>,
      );
      ui.tap?.();
      expect(Linking.openURL).toHaveBeenCalledExactlyOnceWith(ui.href);
      expect(ui.dispatch).not.toHaveBeenCalled();
    },
  );
});
