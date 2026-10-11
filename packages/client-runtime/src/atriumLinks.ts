import remarkParse from "remark-parse";
import { unified } from "unified";

const UID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LOCATOR_PATTERN = new RegExp(
  `^(?:atrium://uid/|uid:)(${UID_PATTERN})(?:\\?([^#\\s]*))?$`,
  "i",
);
const CONTEXT_KEYS = new Set(["rel", "why", "fallback"]);
const CONTEXT_ATTRIBUTES = /^\{((?:\s*(?:rel|why|fallback)="(?:\\.|[^"\\])*"\s*)+)\}/;
const markdownParser = unified().use(remarkParse);

export type AtriumLink =
  | {
      readonly kind: "object";
      readonly uid: string;
      readonly reference: string;
      readonly canonicalReference: string;
      readonly readerUrl: string;
      readonly rel?: string;
      readonly why?: string;
      readonly fallback?: string;
    }
  | { readonly kind: "unsupported"; readonly reference: string; readonly message: string };

/** Identity is validated literally, not repaired by URL parsing. The estate reader
 * sends the bare UID to Atrium Service; no path cache or revision pin is involved. */
export function parseAtriumLink(reference: string): AtriumLink | null {
  if (!/^(?:atrium|uid):/i.test(reference)) return null;
  const unsupported = (message: string): AtriumLink => ({
    kind: "unsupported",
    reference,
    message,
  });
  const match = LOCATOR_PATTERN.exec(reference);
  if (!match?.[1]) {
    return unsupported(
      "Unsupported Atrium link: expected atrium://uid/<UUIDv7>; other address classes are not supported.",
    );
  }
  const query = match[2] ?? "";
  try {
    // URLSearchParams tolerates broken percent escapes, which must not repair an authored reference.
    decodeURIComponent(query.replaceAll("+", " "));
  } catch {
    return unsupported("Unsupported Atrium link: malformed context encoding.");
  }
  const context = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const [key] of context) {
    if (!CONTEXT_KEYS.has(key) || seen.has(key)) {
      return unsupported(
        "Unsupported Atrium link: only one rel, why, and fallback context value is supported; no revision pins.",
      );
    }
    seen.add(key);
  }
  const uid = match[1];
  const canonicalReference = `atrium://uid/${uid}`;
  const reader = new URL("https://atrium.sol.pharos.zone/");
  reader.searchParams.set("note", uid);
  for (const [key, value] of context) reader.searchParams.set(key, value);
  return {
    kind: "object",
    uid,
    reference,
    canonicalReference,
    readerUrl: reader.href,
    ...(context.has("rel") ? { rel: context.get("rel")! } : {}),
    ...(context.has("why") ? { why: context.get("why")! } : {}),
    ...(context.has("fallback") ? { fallback: context.get("fallback")! } : {}),
  };
}

interface MarkdownNode {
  type?: string | undefined;
  url?: string | undefined;
  value?: string | undefined;
  position?: { start: MarkdownPoint; end: MarkdownPoint } | undefined;
  children?: MarkdownNode[] | undefined;
}

interface MarkdownPoint {
  offset?: number | undefined;
  line?: number | undefined;
  column?: number | undefined;
}

function contextualLink(node: MarkdownNode, markdown: string) {
  if (node.type !== "link" || !node.url || parseAtriumLink(node.url)?.kind !== "object")
    return null;
  const end = node.position?.end.offset;
  if (end === undefined) return null;
  const attributes = CONTEXT_ATTRIBUTES.exec(markdown.slice(end));
  if (!attributes) return null;
  const queryAt = node.url.indexOf("?");
  const context = new URLSearchParams(queryAt === -1 ? "" : node.url.slice(queryAt + 1));
  const seen = new Set<string>();
  for (const [, key = "", value = ""] of attributes[1]!.matchAll(
    /(rel|why|fallback)="((?:\\.|[^"\\])*)"/g,
  )) {
    if (seen.has(key)) return null;
    seen.add(key);
    try {
      context.set(key, JSON.parse(`"${value}"`) as string);
    } catch {
      return null;
    }
  }
  return {
    url: `${queryAt === -1 ? node.url : node.url.slice(0, queryAt)}?${context}`,
    attributes: attributes[0],
    end: end + attributes[0].length,
  };
}

function afterText(point: MarkdownPoint, text: string): MarkdownPoint {
  const lines = text.split("\n");
  return {
    offset: (point.offset ?? 0) + text.length,
    line: (point.line ?? 1) + lines.length - 1,
    column: lines.length === 1 ? (point.column ?? 1) + text.length : lines.at(-1)!.length + 1,
  };
}

function textValue(node: MarkdownNode): string {
  return node.value ?? node.children?.map(textValue).join("") ?? "";
}

/** Adapt the parsed link, not the whole source: downstream task/fence/file
 * consumers still address the authored Markdown. Extend only the link's end to
 * include its context, which also preserves the complete authored copy token. */
export function remarkAtriumLinks() {
  return (tree: MarkdownNode, file: { readonly value: unknown }) => {
    const markdown = String(file.value);
    if (!/(?:atrium:\/\/uid\/|uid:)/i.test(markdown) || !markdown.includes("{")) return;
    const visit = (parent: MarkdownNode) => {
      const children = parent.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index]!;
        const context = contextualLink(node, markdown);
        if (context && node.position) {
          node.url = context.url;
          node.position.end = afterText(node.position.end, context.attributes);
          while (children[index + 1]) {
            const tail = children[index + 1]!;
            const start = tail.position?.start.offset;
            const end = tail.position?.end.offset;
            if (start === undefined || end === undefined || start >= context.end) break;
            if (end <= context.end) {
              children.splice(index + 1, 1);
              continue;
            }
            const suffix = markdown.slice(context.end, end);
            // The leading word prevents a text remainder from becoming a block
            // construct. Parsing decodes the same entities/escapes as the source.
            tail.value = textValue(markdownParser.parse(`x${suffix}`)).slice(1);
            tail.type = "text";
            delete tail.children;
            delete tail.url;
            if (tail.position) tail.position.start = { ...node.position.end };
            break;
          }
        }
        visit(node);
      }
    };
    visit(tree);
  };
}

/** Query-form compatibility for the native Markdown engine. The AST locates
 * the label boundary so a decoded destination or matching title cannot cause a
 * substring replacement in the wrong place. Code/images stay as authored. */
export function normalizeAtriumMarkdown(markdown: string): string {
  if (!/(?:atrium:\/\/uid\/|uid:)/i.test(markdown) || !markdown.includes("{")) return markdown;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: MarkdownNode) => {
    const context = contextualLink(node, markdown);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (context && start !== undefined && end !== undefined) {
      const source = markdown.slice(start, end);
      const labelEnd = node.children?.at(-1)?.position?.end.offset ?? start + 1;
      const open = source.indexOf("](", labelEnd - start);
      const destination =
        open === -1 ? null : /^(\s*)(<[^>]*>|[^\s]+)([\s\S]*)$/.exec(source.slice(open + 2, -1));
      if (destination) {
        edits.push({
          start,
          end: context.end,
          text:
            source.slice(0, open + 2) +
            destination[1] +
            (destination[2]!.startsWith("<") ? `<${context.url}>` : context.url) +
            destination[3] +
            ")",
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(markdownParser.parse(markdown));
  let result = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}
