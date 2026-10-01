const MAX_SPEECH_CHARACTERS = 5_000;
const TABLE_SEPARATOR_ROW = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function dropFencedCodeBlocks(markdown: string): string {
  const output: string[] = [];
  let fence: { character: "`" | "~"; length: number } | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (
        marker &&
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        /^\s{0,3}(?:`{3,}|~{3,})\s*$/.test(line)
      ) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[0] as "`" | "~", length: marker.length };
      continue;
    }
    output.push(line);
  }

  return output.join("\n");
}

function dropMarkdownTables(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (header?.includes("|") && separator && TABLE_SEPARATOR_ROW.test(separator)) {
      index += 2;
      while (index < lines.length && lines[index]?.includes("|")) index += 1;
      index -= 1;
      continue;
    }
    if (header !== undefined) output.push(header);
  }

  return output.join("\n");
}

/** Convert an assistant Markdown reply into concise text suitable for speech. */
export function prepareReplySpeechText(markdown: string): string {
  const plain = dropMarkdownTables(dropFencedCodeBlocks(markdown))
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`{1,2}([^`]+)`{1,2}/g, "$1")
    .replace(/<\/?[^>\n]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\\([\\`*_{}[\]()#+.!|>-])/g, "$1")
    .replace(/[\\*~]/g, "")
    // Emphasis underscores go; one inside a word (snake_case) reads as a space.
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return Array.from(plain).slice(0, MAX_SPEECH_CHARACTERS).join("");
}
