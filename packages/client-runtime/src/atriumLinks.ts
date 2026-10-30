import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";
import {
  markdownLineEnding,
  markdownLineEndingOrSpace,
  unicodeWhitespace,
} from "micromark-util-character";
import type { Code, Extension, State, Tokenizer } from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    atriumContext: "atriumContext";
    atriumContextData: "atriumContextData";
  }
}

const UID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const LOCATOR_PATTERN = new RegExp(
  `^(?:atrium://uid/|uid:)(${UID_PATTERN})(?:\\?([^#\\s]*))?$`,
  "i",
);
const CONTEXT_KEYS = new Set(["rel", "why", "fallback"]);
const CONTEXT_ATTRIBUTES = /^\{((?:\s*(?:rel|why|fallback)="(?:\\.|[^"\\])*"\s*)+)\}/;
const plainMarkdownParser = unified().use(remarkParse);
const markdownParser = unified().use(remarkParse).use(remarkAtriumContextSyntax);

/** Keep context strings literal before emphasis/code/link parsing. Only the
 * suffix of an inline Atrium UID link participates, never general brace syntax. */
const tokenizeContext: Tokenizer = function (effects, ok, nok) {
  const last = this.events.at(-1);
  if (last?.[0] !== "exit" || last[1].type !== "link") return nok;
  // Parse only this link: decode its Markdown escapes/entities without
  // borrowing a prior inline destination for a reference-style or empty link.
  const paragraph = plainMarkdownParser.parse(this.sliceSerialize(last[1])).children[0];
  const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
  if (link?.type !== "link" || parseAtriumLink(link.url)?.kind !== "object") return nok;
  const href = link.url;
  let phase: "key" | "quote" | "value" | "after" = "key";
  let key = "";
  let escaped = false;
  const token = effects.enter("atriumContext");
  effects.enter("atriumContextData");
  const context = this;
  return start;

  function start(code: Code): ReturnType<State> {
    if (code !== 123) return nok(code);
    effects.consume(code);
    return read;
  }

  function read(code: Code): ReturnType<State> {
    if (code === null) return nok(code);
    const whitespace = markdownLineEndingOrSpace(code) || unicodeWhitespace(code);
    if (phase === "value") {
      if (escaped) escaped = false;
      else if (code === 92) escaped = true;
      else if (code === 34) phase = "after";
    } else if (phase === "quote") {
      if (code !== 34) return nok(code);
      phase = "value";
    } else if (code === 125 && phase === "after") {
      effects.consume(code);
      effects.exit("atriumContextData");
      effects.exit("atriumContext");
      const raw = context.sliceSerialize(token);
      return contextAttributes(href, raw)?.attributes === raw ? ok : nok;
    } else {
      if (whitespace) {
        if (phase === "key" && key.length > 0) return nok(code);
      } else if (code === 61 && phase === "key" && CONTEXT_KEYS.has(key)) {
        phase = "quote";
      } else {
        if (phase === "after") {
          phase = "key";
          key = "";
        }
        key += String.fromCharCode(code);
        if (![...CONTEXT_KEYS].some((field) => field.startsWith(key))) return nok(code);
      }
    }
    if (markdownLineEnding(code)) {
      effects.exit("atriumContextData");
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      effects.enter("atriumContextData");
    } else {
      effects.consume(code);
    }
    return read;
  }
};

function remarkAtriumContextSyntax(this: Processor) {
  const data = this.data();
  const extension: Extension = { text: { 123: { tokenize: tokenizeContext } } };
  (data.micromarkExtensions ??= []).push(extension);
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      atriumContext(token) {
        // Keep URLs/emails out of GFM's text autolink transform. This literal
        // is removed by the remark adapter before any HTML rendering.
        this.enter({ type: "html", value: "" }, token);
        this.buffer();
      },
    },
    exit: {
      atriumContext(token) {
        this.resume();
        const node = this.stack.at(-1);
        if (node?.type === "html") node.value = this.sliceSerialize(token);
        this.exit(token);
      },
    },
  });
}

export type AtriumLink =
  | {
      readonly kind: "object";
      readonly uid: string;
      readonly reference: string;
      readonly canonicalReference: string;
      readonly canonicalContextReference: string;
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
    canonicalContextReference: `${canonicalReference}${match[2] === undefined ? "" : `?${query}`}`,
    readerUrl: reader.href,
    ...(context.has("rel") ? { rel: context.get("rel")! } : {}),
    ...(context.has("why") ? { why: context.get("why")! } : {}),
    ...(context.has("fallback") ? { fallback: context.get("fallback")! } : {}),
  };
}

/**
 * A destination an Atrium object authors for one of its own files: note-relative
 * (`assets/scan.png`, `../index.json`) or repository-root relative (`/shared/policy.pdf`).
 * It is passed on exactly as authored; Atrium Service resolves it against the object's
 * directory, which a renderer cannot know from the page it is drawn in. In-page anchors,
 * URLs with a scheme, and protocol-relative `//host` destinations are not object files.
 */
export function atriumObjectFileHref(href: string | null | undefined): string | null {
  const value = href?.trim() ?? "";
  if (!value || value.startsWith("#") || value.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return /^<?[^?#]/.test(value) ? value : null;
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
  const context = contextAttributes(node.url, markdown.slice(end));
  return context ? { ...context, end: end + context.attributes.length } : null;
}

function contextAttributes(href: string, source: string) {
  const attributes = CONTEXT_ATTRIBUTES.exec(source);
  if (!attributes) return null;
  const queryAt = href.indexOf("?");
  const context = new URLSearchParams(queryAt === -1 ? "" : href.slice(queryAt + 1));
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
    url: `${queryAt === -1 ? href : href.slice(0, queryAt)}?${context}`,
    attributes: attributes[0],
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

/** Adapt the parsed link, not the whole source: downstream task/fence/file
 * consumers still address the authored Markdown. Extend only the link's end to
 * include its context, which also preserves the complete authored copy token. */
export function remarkAtriumLinks(this: Processor) {
  remarkAtriumContextSyntax.call(this);
  return (tree: MarkdownNode, file: { readonly value: unknown }) => {
    const markdown = String(file.value);
    if (!markdown.includes("{")) return;
    const visit = (parent: MarkdownNode) => {
      const children = parent.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index]!;
        const context = contextualLink(node, markdown);
        const suffix = children[index + 1];
        if (
          context &&
          node.position &&
          suffix?.type === "html" &&
          suffix.value === context.attributes &&
          suffix.position?.start.offset === node.position.end.offset
        ) {
          node.url = context.url;
          node.position.end = afterText(node.position.end, context.attributes);
          children.splice(index + 1, 1);
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
  if (!markdown.includes("{")) return markdown;
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
