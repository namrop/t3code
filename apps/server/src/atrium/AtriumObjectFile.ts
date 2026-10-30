import * as Effect from "effect/Effect";
import {
  HttpClient,
  HttpClientRequest,
  HttpServerResponse,
  type HttpClientResponse,
} from "effect/http";

import { ATRIUM_SERVICE_ORIGIN } from "./AtriumObjectReader.ts";

/** Labels the body keeps: pictures, recordings, PDFs, and plain text or data. */
const MEDIA_CONTENT_TYPE_PATTERN = /^(?:image|video|audio)\/[\w!#$&^.+-]+$/i;
const READABLE_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/x-ndjson",
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/yaml",
]);
const FORWARDED_RESPONSE_HEADERS = ["content-length", "content-disposition", "last-modified"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/**
 * Serves a file an Atrium object references, read through Atrium Service. The Service resolves
 * the authored destination against the object's own directory, so this route never learns
 * where the canon lives. This origin holds the user's session, so anything that is not a picture,
 * recording, PDF, or plain text/data is sent as a download rather than rendered here.
 */
export const atriumObjectFileResponse = Effect.fn("AtriumObjectFile.response")(function* (asset: {
  readonly uid: string;
  readonly href: string;
}) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const headers: Record<string, string> = {
    // The note's working tree is the source, and it can change under the same name.
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  const response: HttpClientResponse.HttpClientResponse | null = yield* httpClient
    .execute(
      HttpClientRequest.get(`${ATRIUM_SERVICE_ORIGIN}/api/object-file`).pipe(
        HttpClientRequest.setUrlParams({ ref: asset.uid, href: asset.href }),
        // The bytes are streamed straight through, so never let an encoding layer in.
        HttpClientRequest.setHeaders({ "accept-encoding": "identity" }),
      ),
    )
    .pipe(
      Effect.timeout("30 seconds"),
      Effect.orElseSucceed(() => null),
    );
  if (response === null) return HttpServerResponse.empty({ status: 502, headers });
  // A missing or unreferenced file is the client's answer; only a broken hop is ours. No upstream
  // entity headers: a `content-length` with no body behind it holds the connection open.
  if (response.status >= 400) {
    return HttpServerResponse.empty({
      status: response.status >= 500 ? 502 : response.status,
      headers,
    });
  }
  const upstreamType = response.headers["content-type"]?.trim() ?? "";
  const mediaType = upstreamType.split(";", 1)[0]!.trim().toLowerCase();
  const readable =
    MEDIA_CONTENT_TYPE_PATTERN.test(mediaType) || READABLE_CONTENT_TYPES.has(mediaType);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers[name];
    if (value !== undefined) headers[name] = value;
  }
  const contentType = readable ? upstreamType : "application/octet-stream";
  headers["content-type"] = contentType;
  if (!readable) {
    headers["content-disposition"] = (headers["content-disposition"] ?? "attachment").replace(
      /^\s*inline\b/i,
      "attachment",
    );
  }
  if (mediaType === "image/svg+xml") {
    headers["content-security-policy"] = SVG_CONTENT_SECURITY_POLICY;
  }
  return HttpServerResponse.stream(response.stream, { status: 200, headers, contentType });
});
