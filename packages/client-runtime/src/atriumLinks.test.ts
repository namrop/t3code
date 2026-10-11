import { describe, expect, it } from "vite-plus/test";

import { normalizeAtriumMarkdown, parseAtriumLink } from "./atriumLinks.ts";

const UID = "01900000-0000-7000-8000-000000000001";
const REF = `atrium://uid/${UID}`;

describe("Atrium object navigation", () => {
  it("projects canonical identity to the existing reader's UID deep link", () => {
    const link = parseAtriumLink(REF);
    expect(link?.kind).toBe("object");
    if (link?.kind !== "object") throw new Error("Missing object link");
    const url = new URL(link.readerUrl);
    expect(url.origin).toBe("https://atrium.sol.pharos.zone");
    expect(url.searchParams.get("note")).toBe(UID);
    expect(link.reference).toBe(REF);
    expect(link.canonicalReference).toBe(REF);
  });

  it("retains query context separately from the UID used by Service", () => {
    const reference = `${REF}?rel=review&why=Review%20the%20current%20object&fallback=url%3Ahttps%3A%2F%2Fexample.com%2Fsource`;
    const link = parseAtriumLink(reference);
    expect(link).toMatchObject({
      kind: "object",
      uid: UID,
      reference,
      canonicalReference: REF,
      rel: "review",
      why: "Review the current object",
      fallback: "url:https://example.com/source",
    });
    if (link?.kind !== "object") throw new Error("Missing object link");
    expect(new URL(link.readerUrl).searchParams.get("note")).toBe(UID);
    expect(new URL(link.readerUrl).searchParams.get("why")).toBe("Review the current object");
  });

  it("accepts the authoring shorthand without changing its literal UID", () => {
    expect(parseAtriumLink(`uid:${UID}`)).toMatchObject({
      kind: "object",
      uid: UID,
      canonicalReference: REF,
    });
  });

  it.each([
    "atrium://beam/example",
    "atrium://bundle/example",
    "atrium://blob/example",
    "atrium://query/example",
    "atrium:path/example.md#uid=" + UID,
    "atrium://uid/not-a-uuid",
    "atrium://uid/01900000-0000-4000-8000-000000000001",
    "atrium://uid/01900000-0000-7000-0000-000000000001",
    `${REF}/extra`,
    `${REF}/`,
    `atrium://user@uid/${UID}`,
    `atrium://uid:123/${UID}`,
    `atrium://uid/%30${UID.slice(1)}`,
    `${REF}#revision`,
    `${REF}?revision=old`,
    `${REF}?why=%GG`,
    `${REF}?why=a&why=b`,
  ])("explains unsupported or malformed locators rather than launching %s", (reference) => {
    expect(parseAtriumLink(reference)).toMatchObject({
      kind: "unsupported",
      reference,
      message: expect.any(String),
    });
  });

  it.each([
    "https://example.com",
    "http://localhost:1234",
    "mailto:a@example.com",
    "tel:123",
    "file:///tmp/report.md",
    "src/main.ts:12",
    "C:/src/main.ts",
    "t3-citation://example",
    "t3-context://v1/terminal/test",
    "javascript:alert(1)",
  ])("does not take over existing destinations: %s", (href) =>
    expect(parseAtriumLink(href)).toBeNull(),
  );
});

describe("Atrium contextual Markdown", () => {
  it("decodes authored query entities before adding body context", () => {
    expect(
      normalizeAtriumMarkdown(
        `[Object](${REF}?rel=source&amp;why=Read){fallback="url:https://example.com"}`,
      ),
    ).toBe(`[Object](${REF}?rel=source&why=Read&fallback=url%3Ahttps%3A%2F%2Fexample.com)`);
  });

  it("does not confuse a title containing the reference with the destination", () => {
    expect(normalizeAtriumMarkdown(`[Object](${REF} "${REF}"){why="Read"}`)).toBe(
      `[Object](${REF}?why=Read "${REF}")`,
    );
  });

  it("carries canonical body attributes into the query compatibility form", () => {
    const markdown = `[**Object**](${REF}){rel="review" why="Read the current object" fallback="url:https://example.com/source"}`;
    const normalized = normalizeAtriumMarkdown(markdown);
    expect(normalized).toBe(
      `[**Object**](${REF}?rel=review&why=Read+the+current+object&fallback=url%3Ahttps%3A%2F%2Fexample.com%2Fsource)`,
    );
    expect(normalizeAtriumMarkdown(normalized)).toBe(normalized);
  });

  it("does not alter code, non-Atrium links, incomplete streaming attributes, or unknown attributes", () => {
    const source = `[Object](${REF}){why="Read it"}`;
    for (const markdown of [
      `\`${source}\``,
      `\`\`\`md\n${source}\n\`\`\``,
      '[Site](https://example.com){why="Read it"}',
      `[Object](${REF}){why="Not done`,
      `[Object](${REF}){unknown="Keep me"}`,
    ]) {
      expect(normalizeAtriumMarkdown(markdown)).toBe(markdown);
    }
  });

  it("uses contextual attributes over duplicate query context, without changing other prose", () => {
    expect(normalizeAtriumMarkdown(`Before [Object](${REF}?why=old){why="new"} after`)).toBe(
      `Before [Object](${REF}?why=new) after`,
    );
  });
});
