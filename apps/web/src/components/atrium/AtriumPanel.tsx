import { parseAtriumLink } from "@t3tools/client-runtime/atrium-links";
import { AtriumReadObjectError, type ScopedThreadRef } from "@t3tools/contracts";
import { Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import * as Schema from "effect/Schema";

import ChatMarkdown from "~/components/ChatMarkdown";
import {
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
} from "~/components/files/fileSurfaceChrome";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

const isAtriumReadObjectError = Schema.is(AtriumReadObjectError);

export function AtriumPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "atrium" }>;
  readonly visible: boolean;
}) {
  const { threadRef, surface, visible } = props;
  const link = parseAtriumLink(surface.reference);
  const atom = visible
    ? serverEnvironment.readAtriumObject({
        environmentId: threadRef.environmentId,
        input: { uid: surface.uid },
      })
    : null;
  const query = useEnvironmentQuery(atom);
  const refresh = query.refresh;
  const lastRead = useRef<{ atom: typeof atom; requestId: number } | null>(null);
  useEffect(() => {
    // Mount/reopen revalidation belongs to the shared atom. Refresh only an explicit
    // repeated open while this object is already mounted, avoiding two initial reads.
    if (
      atom &&
      lastRead.current?.atom === atom &&
      lastRead.current.requestId !== surface.readRequestId
    )
      refresh();
    lastRead.current = { atom, requestId: surface.readRequestId };
  }, [atom, surface.readRequestId, refresh]);

  const object = query.data;
  useEffect(() => {
    if (object && !query.isPending && query.isSuccess)
      useRightPanelStore.getState().updateAtriumTitle(threadRef, surface.uid, object.title);
  }, [object, query.isPending, query.isSuccess, threadRef, surface.uid]);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Atrium context link",
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to copy Atrium link",
          description: error.message,
        }),
      ),
  });
  const reason = isAtriumReadObjectError(query.failure) ? query.failure.reason : "unavailable";
  const failureMessage =
    reason === "not-found"
      ? "Atrium object not found. It may have been removed."
      : reason === "invalid-response"
        ? "Invalid Atrium response. The service did not return a readable object."
        : "Atrium Service unavailable. The current object could not be read from this environment.";
  const canonicalContextLink =
    link?.kind === "object" ? link.canonicalContextReference : surface.reference;

  return (
    <section aria-label="Atrium object" className="flex h-full min-h-0 min-w-0 flex-col">
      <div className={FILE_SURFACE_SUBHEADER_CLASS}>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">Atrium object</span>
        <FileSurfaceAction
          label={isCopied ? "Copied Atrium context link" : "Copy Atrium context link"}
          onPress={() => copyToClipboard(canonicalContextLink, undefined)}
        >
          {isCopied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Refresh Atrium object"
          disabled={query.isPending}
          onPress={query.refresh}
        >
          <RefreshCw className="size-3.5" />
        </FileSurfaceAction>
      </div>
      {query.isPending || (!query.isSuccess && query.error === null) ? (
        <div
          role="status"
          className="flex min-h-0 flex-1 items-center justify-center gap-2 text-xs text-muted-foreground"
        >
          <Spinner size="sm" /> Loading Atrium object
        </div>
      ) : query.error ? (
        <FileSurfaceFailure message={failureMessage} onRetry={query.refresh} />
      ) : object ? (
        <ScrollArea className="min-w-0 flex-1">
          <article className="mx-auto max-w-4xl px-6 py-5 [overflow-wrap:anywhere]">
            <h1 className="mb-2 text-lg font-semibold">{object.title}</h1>
            <dl className="mb-4 space-y-1 text-xs text-muted-foreground">
              <div>
                <dt className="inline">UID: </dt>
                <dd className="inline font-mono">{surface.uid}</dd>
              </div>
              {object.kind ? (
                <div>
                  <dt className="inline">Kind: </dt>
                  <dd className="inline">{object.kind}</dd>
                </div>
              ) : null}
              {object.path ? (
                <div>
                  <dt className="inline">Path: </dt>
                  <dd className="inline">{object.path}</dd>
                </div>
              ) : null}
            </dl>
            {link?.kind === "object" && (link.rel || link.why || link.fallback) ? (
              <dl className="mb-4 space-y-1 text-xs text-muted-foreground">
                {link.rel ? (
                  <div>
                    <dt className="inline">Relation: </dt>
                    <dd className="inline">{link.rel}</dd>
                  </div>
                ) : null}
                {link.why ? (
                  <div>
                    <dt className="inline">Why: </dt>
                    <dd className="inline">{link.why}</dd>
                  </div>
                ) : null}
                {link.fallback ? (
                  <div>
                    <dt className="inline">Fallback: </dt>
                    <dd className="inline">{link.fallback}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            <ChatMarkdown
              text={object.body}
              cwd={undefined}
              threadRef={threadRef}
              workspaceLinks={false}
              atriumObjectUid={object.uid}
              headingLevelOffset={1}
            />
          </article>
        </ScrollArea>
      ) : null}
      {link?.kind === "object" ? (
        <div className="shrink-0 border-t border-border/60 px-3 py-2 text-xs">
          <a
            href={link.readerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground underline underline-offset-2"
          >
            Open in estate reader
          </a>
        </div>
      ) : null}
    </section>
  );
}
