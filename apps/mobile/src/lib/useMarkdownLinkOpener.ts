import { NavigationContext, StackActions } from "@react-navigation/native";
import { useCallback, useContext } from "react";

import { tryOpenExternalUrl } from "./openExternalUrl";

/** In-app when scoped; standalone Markdown retains its external-reader fallback. */
export function useMarkdownLinkOpener(scope: {
  readonly environmentId?: string;
  readonly threadId?: string | null;
}) {
  const navigation = useContext(NavigationContext);
  return useCallback(
    (href: string) => {
      void tryOpenExternalUrl(
        href,
        "markdown-link",
        navigation && scope.environmentId
          ? {
              environmentId: scope.environmentId,
              threadId: scope.threadId,
              openAtriumObject: (params) =>
                navigation.dispatch(StackActions.push("AtriumObject", params)),
            }
          : undefined,
      );
    },
    [navigation, scope.environmentId, scope.threadId],
  );
}
