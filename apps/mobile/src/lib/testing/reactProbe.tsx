import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vite-plus/test";

/** Mount hook/native-boundary probes with no browser or DOM output. */
export function createReactProbe() {
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  const container = {
    nodeType: 1,
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    addEventListener() {},
    removeEventListener() {},
  };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(container as unknown as HTMLElement);
  return {
    async render(children: ReactNode) {
      await act(() => root.render(children));
    },
    async dispose() {
      await act(() => root.unmount());
      vi.unstubAllGlobals();
    },
  };
}
