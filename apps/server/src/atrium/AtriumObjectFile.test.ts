import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/http";

import { atriumObjectFileResponse } from "./AtriumObjectFile.ts";

const UID = "01900000-0000-7000-8000-000000000001";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const serve = (
  upstream: (url: URL) => Response,
  asset: { readonly uid: string; readonly href: string } = { uid: UID, href: "assets/scan.png" },
) => {
  const urls: string[] = [];
  return Effect.gen(function* () {
    const response = yield* atriumObjectFileResponse(asset);
    const web = HttpServerResponse.toWeb(response);
    return { response, urls, body: new Uint8Array(yield* Effect.promise(() => web.arrayBuffer())) };
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request, url) =>
        Effect.sync(() => {
          urls.push(url.toString());
          return HttpClientResponse.fromWeb(request, upstream(url));
        }),
      ),
    ),
    Effect.scoped,
  );
};

describe("atriumObjectFileResponse", () => {
  it.effect("asks Atrium Service for the object's own file and streams its bytes", () =>
    Effect.gen(function* () {
      const { response, urls, body } = yield* serve(
        () =>
          new Response(PNG, {
            headers: {
              "content-type": "image/png",
              "content-length": String(PNG.length),
              "content-disposition": "inline; filename*=UTF-8''scan%20full.png",
            },
          }),
        { uid: UID, href: "assets/scan full.png" },
      );
      expect(urls).toEqual([
        `https://atrium.sol.pharos.zone/api/object-file?ref=${UID}&href=assets%2Fscan+full.png`,
      ]);
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["content-disposition"]).toBe(
        "inline; filename*=UTF-8''scan%20full.png",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(body).toEqual(PNG);
    }),
  );

  it.effect("keeps readable document types such as PDF, JSON and text", () =>
    Effect.gen(function* () {
      for (const type of [
        "application/pdf",
        "application/json; charset=utf-8",
        "text/plain; charset=utf-8",
      ]) {
        const { response } = yield* serve(
          () => new Response("x", { headers: { "content-type": type } }),
        );
        expect(response.headers["content-type"]).toBe(type);
      }
    }),
  );

  it.effect("downloads anything that could run as a document on this origin", () =>
    Effect.gen(function* () {
      const { response } = yield* serve(
        () =>
          new Response("<script>alert(1)</script>", {
            headers: {
              "content-type": "text/html",
              "content-disposition": "inline; filename*=UTF-8''page.html",
            },
          }),
      );
      expect(response.headers["content-type"]).toBe("application/octet-stream");
      expect(response.headers["content-disposition"]).toBe(
        "attachment; filename*=UTF-8''page.html",
      );
    }),
  );

  it.effect("sandboxes SVG", () =>
    Effect.gen(function* () {
      const { response } = yield* serve(
        () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      );
      expect(response.headers["content-security-policy"]).toContain("sandbox");
    }),
  );

  it.effect(
    "passes a missing or unreferenced file on as a bodiless 404 and a broken hop as 502",
    () =>
      Effect.gen(function* () {
        const missing = yield* serve(() =>
          Response.json({ ok: false }, { status: 404, headers: { "content-length": "999" } }),
        );
        expect(missing.response.status).toBe(404);
        expect(missing.response.headers["content-length"]).toBeUndefined();
        expect(missing.body).toHaveLength(0);
        const broken = yield* serve(() => new Response("boom", { status: 500 }));
        expect(broken.response.status).toBe(502);
      }),
  );
});
