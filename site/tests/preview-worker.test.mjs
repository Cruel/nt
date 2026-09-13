import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { resolvePreviewUpstream } from "../public/_worker.js";

const revision = "a".repeat(40);
const token = `pr-42/${revision}`;

function request(path, init = {}) {
  return new Request(`https://noveltea.pages.dev${path}`, init);
}

test("preview worker only maps strict immutable preview paths to R2", () => {
  assert.equal(
    resolvePreviewUpstream(
      `https://noveltea.pages.dev/examples/dev/preview-assets/${token}/preview.json`,
    ),
    `https://assets.noveltea.dev/development/example-previews/${token}/preview.json`,
  );
  assert.equal(
    resolvePreviewUpstream(
      `https://noveltea.dev/examples/dev/preview-assets/${token}/preview.json`,
    ),
    null,
  );
  assert.equal(
    resolvePreviewUpstream(
      `https://noveltea.pages.dev/examples/dev/preview-assets/pr-42/main/preview.json`,
    ),
    null,
  );
  assert.equal(
    resolvePreviewUpstream(
      `https://noveltea.pages.dev/examples/dev/preview-assets/${token}/../secret`,
    ),
    null,
  );
});

test("preview worker injects isolation headers and otherwise falls through to Pages assets", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response("preview", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "bad=1" },
    });
  };
  try {
    const response = await worker.fetch(
      request(`/examples/dev/preview-assets/${token}/playable/materials/index.html`),
      { ASSETS: { fetch: async () => new Response("asset") } },
    );
    assert.equal(
      calls[0].url,
      `https://assets.noveltea.dev/development/example-previews/${token}/playable/materials/index.html`,
    );
    assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "cross-origin");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Set-Cookie"), null);

    let assetCalled = false;
    const assetResponse = await worker.fetch(request("/docs/"), {
      ASSETS: {
        fetch: async () => {
          assetCalled = true;
          return new Response("docs");
        },
      },
    });
    assert.equal(assetCalled, true);
    assert.equal(await assetResponse.text(), "docs");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
