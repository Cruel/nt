const previewHost = "noveltea.pages.dev";
const storageOrigin = "https://assets.noveltea.dev";
const previewPathPattern =
  /^\/examples\/dev\/preview-assets\/(pr-[1-9][0-9]*\/[0-9a-f]{40})\/([A-Za-z0-9._/-]+)$/;

export function resolvePreviewUpstream(requestUrl) {
  const url = new URL(requestUrl);
  if (url.hostname !== previewHost) return null;
  const match = previewPathPattern.exec(url.pathname);
  if (!match) return null;
  const relativePath = match[2];
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return `${storageOrigin}/development/example-previews/${match[1]}/${relativePath}`;
}

function upstreamHeaders(request) {
  const headers = new Headers();
  for (const name of ["Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function isolatedResponse(response) {
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Permissions-Policy", "cross-origin-isolated=(self)");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const previewPath = url.pathname.startsWith("/examples/dev/preview-assets/");
    const upstream = resolvePreviewUpstream(request.url);
    if (previewPath) {
      if (!upstream) return new Response("Not found", { status: 404 });
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      const response = await fetch(upstream, {
        method: request.method,
        headers: upstreamHeaders(request),
        redirect: "error",
      });
      return isolatedResponse(response);
    }
    return env.ASSETS.fetch(request);
  },
};
