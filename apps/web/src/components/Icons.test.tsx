// @effect-diagnostics nodeBuiltinImport:off - verifies the shipped provider image bytes on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { HERMES_LOGO_ASSET } from "./Icons";

describe("Hermes provider logo", () => {
  it("ships the official Hermes Agent logo bytes at the provider icon path", () => {
    const bytes = NodeFS.readFileSync(
      new URL("../../public/providers/hermes.png", import.meta.url),
    );

    expect(HERMES_LOGO_ASSET).toEqual({
      href: "/providers/hermes.png",
      width: 150,
      height: 150,
      sha256: "2627a50f6826b2fae83183533efee34c8fb8197bc5af60872420c894e8f5b9eb",
    });
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(HERMES_LOGO_ASSET.width);
    expect(bytes.readUInt32BE(20)).toBe(HERMES_LOGO_ASSET.height);
    expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
      HERMES_LOGO_ASSET.sha256,
    );
  });
});
