import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseAtriumLink } from "@t3tools/client-runtime/atrium-links";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { View } from "react-native";

import { EmptyState } from "../../components/EmptyState";
import { ScreenHeader } from "../../components/ScreenHeader";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import type { AtriumObjectRouteParams } from "../../lib/openExternalUrl";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { FileMarkdownPreview } from "../files/FileMarkdownPreview";
import { FilePreviewLoading } from "../files/FilePreviewFeedback";

export function AtriumObjectRouteScreen({ route }: StaticScreenProps<AtriumObjectRouteParams>) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const link = parseAtriumLink(route.params.reference ?? "");
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = route.params.threadId ? ThreadId.make(route.params.threadId) : null;
  const uid = link?.kind === "object" ? link.uid : null;
  const atom = useMemo(() => {
    if (uid === null) return null;
    const source = serverEnvironment.readAtriumObject({ environmentId, input: { uid } });
    return Atom.readable(
      (get) => {
        // Invalidate before observing, not in a post-mount focus effect that
        // would duplicate the initial read. A same-UID push can overlap the
        // covered screen's subscription, so each focus needs its own lifetime.
        get.refresh(source);
        get.subscribe(source, (result) => get.setSelf(result));
        return get.once(source);
      },
      (refresh) => refresh(source),
    ).pipe(Atom.setIdleTTL(0));
  }, [environmentId, uid]);
  const query = useEnvironmentQuery(focused ? atom : null);
  const object = query.data;
  const supported = link?.kind === "object";
  const onBack = () => navigation.goBack();

  return (
    <View className="flex-1 bg-sheet">
      <ScreenHeader
        title={object?.title || "Atrium object"}
        subtitle={object ? [object.path, object.kind].filter(Boolean).join(" · ") : undefined}
        sidebar={false}
        onBack={onBack}
        backInSplitView={{ accessibilityLabel: "Back", icon: "chevron.left", onPress: onBack }}
        optionsVersion={[object?.uid, route.params.reference]}
        menus={
          supported
            ? [
                {
                  title: "Atrium object options",
                  icon: "ellipsis",
                  items: [
                    {
                      id: "copy-link",
                      title: "Copy canonical link",
                      icon: "link",
                      onPress: () =>
                        copyTextWithHaptic(link.canonicalContextReference, {
                          target: "Atrium link",
                        }),
                    },
                    {
                      id: "open-reader",
                      title: "Open estate reader",
                      icon: "arrow.up.right.square",
                      onPress: () => {
                        void tryOpenExternalUrl(link.reference, "markdown-link");
                      },
                    },
                  ],
                },
              ]
            : undefined
        }
      />
      {!supported ? (
        <View className="flex-1 items-center justify-center px-6">
          <EmptyState
            title="Unsupported Atrium link"
            detail={
              link?.message ??
              "Unsupported Atrium link: expected a canonical UUIDv7 object reference."
            }
          />
        </View>
      ) : query.error ? (
        <View className="flex-1 items-center justify-center px-6">
          <EmptyState
            title="Unable to read Atrium object"
            detail={query.error}
            actionLabel="Try again"
            onAction={query.refresh}
          />
        </View>
      ) : object === null ? (
        <FilePreviewLoading message="Loading Atrium object..." />
      ) : (
        <FileMarkdownPreview
          cwd=""
          relativePath=""
          captured
          environmentId={environmentId}
          threadId={threadId}
          markdown={object.body}
          onRefresh={query.refresh}
        />
      )}
    </View>
  );
}
