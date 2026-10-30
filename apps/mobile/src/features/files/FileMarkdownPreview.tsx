import type { AtriumUid, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  atriumObjectFileHref,
  normalizeAtriumMarkdown,
} from "@t3tools/client-runtime/atrium-links";
import { resolveMarkdownLinkPresentation } from "@t3tools/mobile-markdown-text/links";
import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import { assetUrlStateFromResult } from "@t3tools/client-runtime/state/assets";
import { getBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { useCallback, useMemo, useState } from "react";
import {
  Markdown,
  type CustomRenderers,
  type NodeStyleOverrides,
  type PartialMarkdownTheme,
} from "react-native-nitro-markdown";
import { Alert, RefreshControl, ScrollView, Text as NativeText, View } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useMarkdownLinkOpener } from "../../lib/useMarkdownLinkOpener";
import { useFontFamily } from "../../lib/useFontFamily";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import {
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
} from "../../lib/appearancePreferences";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  ThreadMarkdownImage,
  ThreadMarkdownImageUnavailable,
} from "../threads/ThreadMarkdownImage";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  hasNativeSelectableMarkdownText,
  SelectableMarkdownText,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
} from "../../native/SelectableMarkdownText";
import { resolveWorkspaceFilePath } from "./filePath";

interface MarkdownPreviewStyles {
  readonly theme: PartialMarkdownTheme;
  readonly styles: NodeStyleOverrides;
  readonly renderers: CustomRenderers;
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

function useMarkdownPreviewStyles(
  onLinkPress: (href: string) => void,
  renderImage?: MarkdownImageRenderer,
): MarkdownPreviewStyles {
  const { appearance } = useAppearancePreferences();
  const markdownFontSizes = useMemo(
    () => resolveMarkdownFontSizes(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const nativeMarkdownTypography = useMemo(
    () => resolveNativeMarkdownTypography(appearance.baseFontSize),
    [appearance.baseFontSize],
  );
  const theme = useUniwindTheme();
  const body = theme["--color-md-body"];
  const strong = theme["--color-md-strong"];
  const link = theme["--color-md-link"];
  const blockquoteBorder = theme["--color-md-blockquote-border"];
  const blockquoteBackground = theme["--color-md-blockquote-bg"];
  const codeBackground = theme["--color-md-code-bg"];
  const codeText = theme["--color-md-code-text"];
  const horizontalRule = theme["--color-md-hr"];
  const regularFontFamily = useFontFamily("regular");
  const mediumFontFamily = useFontFamily("medium");
  const boldFontFamily = useFontFamily("bold");

  return useMemo(() => {
    const renderers: CustomRenderers = {
      link: ({ href, children }) => {
        const presentation = resolveMarkdownLinkPresentation(href ?? "");
        return (
          <NativeText
            className="font-t3-medium"
            onPress={() => {
              if (href) {
                onLinkPress(href);
              }
            }}
            style={{
              color: link,
              textDecorationLine: "none",
            }}
          >
            {children}
            {presentation.kind === "atrium" && presentation.link.kind === "unsupported"
              ? " (unsupported Atrium link)"
              : null}
          </NativeText>
        );
      },
      image: ({ node }) =>
        node.href && renderImage
          ? (renderImage({
              href: node.href,
              alt: node.alt ?? null,
              title: node.title ?? null,
            }) ?? undefined)
          : undefined,
    };

    return {
      theme: {
        colors: {
          text: body,
          heading: strong,
          link,
          blockquote: blockquoteBorder,
          border: horizontalRule,
          surface: "transparent",
          surfaceLight: blockquoteBackground,
          accent: link,
          tableBorder: horizontalRule,
          tableHeader: blockquoteBackground,
          tableHeaderText: strong,
          tableRowOdd: blockquoteBackground,
          tableRowEven: "transparent",
          code: codeText,
          codeBackground,
        },
      },
      styles: {
        text: {
          color: body,
          fontFamily: regularFontFamily,
          fontSize: markdownFontSizes.m,
          lineHeight: markdownFontSizes.bodyLineHeight,
        },
        heading: {
          color: strong,
          fontFamily: boldFontFamily,
        },
        strong: {
          color: strong,
          fontFamily: boldFontFamily,
        },
        link: {
          color: link,
          fontFamily: mediumFontFamily,
        },
        blockquote: {
          backgroundColor: blockquoteBackground,
          borderLeftColor: blockquoteBorder,
          borderLeftWidth: 3,
          paddingLeft: 12,
        },
        code: {
          backgroundColor: codeBackground,
          color: codeText,
          fontFamily: "ui-monospace",
        },
        codeBlock: {
          backgroundColor: codeBackground,
          borderRadius: 12,
          color: codeText,
          fontFamily: "ui-monospace",
          padding: 12,
        },
        hr: {
          backgroundColor: horizontalRule,
        },
      },
      renderers,
      nativeTextStyle: {
        color: body,
        strongColor: strong,
        mutedColor: body,
        linkColor: link,
        inlineCodeColor: codeText,
        codeColor: codeText,
        codeBackgroundColor: codeBackground,
        codeBlockBackgroundColor: codeBackground,
        fileTextColor: codeText,
        skillTextColor: codeText,
        quoteMarkerColor: blockquoteBorder,
        dividerColor: horizontalRule,
        fontSize: nativeMarkdownTypography.fontSize,
        lineHeight: nativeMarkdownTypography.lineHeight,
        headingFontSizes: nativeMarkdownTypography.headingFontSizes,
        fontFamily: regularFontFamily,
        headingFontFamily: boldFontFamily,
        boldFontFamily,
      },
    };
  }, [
    blockquoteBackground,
    blockquoteBorder,
    body,
    codeBackground,
    codeText,
    horizontalRule,
    link,
    markdownFontSizes,
    mediumFontFamily,
    nativeMarkdownTypography,
    onLinkPress,
    regularFontFamily,
    renderImage,
    strong,
    boldFontFamily,
  ]);
}

export function FileMarkdownPreview(props: {
  readonly cwd: string;
  readonly captured?: boolean;
  readonly environmentId: EnvironmentId;
  readonly markdown: string;
  readonly relativePath: string;
  /** Absent for a file opened from a project draft, which has no thread yet. */
  readonly threadId: ThreadId | null;
  /** The Atrium object this body belongs to. Its note-relative images and file links load
      through Atrium Service, which resolves them against the object's own directory. */
  readonly atriumObjectUid?: AtriumUid;
  readonly onRefresh?: () => Promise<void> | void;
}) {
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullToRefresh = useCallback(async () => {
    if (!props.onRefresh) {
      return;
    }
    setIsPullRefreshing(true);
    try {
      await props.onRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [props.onRefresh]);
  const markdownDirectory = useMemo(
    () => getBrowseDirectoryPath(resolveWorkspaceFilePath(props.cwd, props.relativePath)),
    [props.cwd, props.relativePath],
  );
  const renderImage = useCallback<MarkdownImageRenderer>(
    (image) => {
      const atriumHref =
        props.atriumObjectUid === undefined ? null : atriumObjectFileHref(image.href);
      if (atriumHref !== null && props.atriumObjectUid !== undefined) {
        return (
          <ThreadMarkdownImage
            environmentId={props.environmentId}
            resource={{ _tag: "atrium-file", uid: props.atriumObjectUid, href: atriumHref }}
            alt={image.alt}
            onPressPreview={() => undefined}
          />
        );
      }
      const media = resolveMediaSource(image.href, {
        threadId: props.threadId ?? undefined,
        workspaceRoot: markdownDirectory,
        imageEmbed: true,
      });
      if (media?.access === "direct") {
        return null;
      }
      if (
        props.captured ||
        media === null ||
        media.kind !== "image" ||
        media.access === "unavailable"
      ) {
        return <ThreadMarkdownImageUnavailable alt={image.alt} />;
      }
      return (
        <ThreadMarkdownImage
          environmentId={props.environmentId}
          resource={media.resource}
          alt={image.alt}
          srcFragment={media.srcFragment}
          onPressPreview={() => undefined}
        />
      );
    },
    [markdownDirectory, props.atriumObjectUid, props.environmentId, props.threadId, props.captured],
  );
  const openMarkdownLink = useMarkdownLinkOpener({
    environmentId: props.environmentId,
    threadId: props.threadId,
  });
  const openAtriumFile = useAtriumObjectFileOpener(props.environmentId, props.atriumObjectUid);
  const onLinkPress = useCallback(
    (href: string) => {
      if (!openAtriumFile(href)) openMarkdownLink(href);
    },
    [openAtriumFile, openMarkdownLink],
  );
  const styles = useMarkdownPreviewStyles(onLinkPress, renderImage);
  const normalizedMarkdown = useMemo(
    () => normalizeAtriumMarkdown(props.markdown),
    [props.markdown],
  );

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ padding: 18 }}
      refreshControl={
        props.onRefresh ? (
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullToRefresh()}
          />
        ) : undefined
      }
    >
      <View className="mx-auto w-full max-w-[760px]">
        {hasNativeSelectableMarkdownText() ? (
          <SelectableMarkdownText
            markdown={props.markdown}
            onLinkPress={onLinkPress}
            renderImage={renderImage}
            textStyle={styles.nativeTextStyle}
          />
        ) : (
          <Markdown
            options={{ gfm: true }}
            renderers={styles.renderers}
            styles={styles.styles}
            theme={styles.theme}
          >
            {normalizedMarkdown}
          </Markdown>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * Opens a file an Atrium object links, such as a receipt's PDF, in the system viewer through a
 * freshly signed asset URL. Returns false for links that are not the object's own files.
 */
function useAtriumObjectFileOpener(
  environmentId: EnvironmentId,
  atriumObjectUid: AtriumUid | undefined,
) {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(
    (href: string) => {
      const atriumHref = atriumObjectUid === undefined ? null : atriumObjectFileHref(href);
      if (atriumHref === null || atriumObjectUid === undefined) return false;
      void (async () => {
        const state =
          httpBaseUrl === null
            ? null
            : assetUrlStateFromResult(
                await createUrl({
                  environmentId,
                  input: {
                    resource: { _tag: "atrium-file", uid: atriumObjectUid, href: atriumHref },
                  },
                }),
                httpBaseUrl,
              );
        if (state?._tag === "Success") {
          await tryOpenExternalUrl(state.url, "file-preview");
        } else {
          Alert.alert("File unavailable", "This file could not be opened from Atrium.");
        }
      })();
      return true;
    },
    [atriumObjectUid, createUrl, environmentId, httpBaseUrl],
  );
}
