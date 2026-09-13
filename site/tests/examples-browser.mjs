import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const siteRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(siteRoot, "dist");

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".css", "text/css; charset=utf-8"],
  [".png", "image/png"],
  [".ico", "image/x-icon"],
  [".webmanifest", "application/manifest+json"],
]);

function resolveRequestPath(url) {
  const pathname = new URL(url, "http://localhost").pathname;
  const relative = pathname.replace(/^\/+/, "");
  let candidate = resolve(distRoot, relative || "index.html");
  if (!candidate.startsWith(`${distRoot}/`) && candidate !== distRoot) return null;
  if (existsSync(candidate) && statSync(candidate).isDirectory())
    candidate = join(candidate, "index.html");
  if (!existsSync(candidate) && !extname(candidate)) candidate = join(candidate, "index.html");
  return existsSync(candidate) && statSync(candidate).isFile() ? normalize(candidate) : null;
}

async function withServer(run) {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const path = resolveRequestPath(request.url ?? "/");
    if (!path) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (pathname === "/examples/dev" || pathname.startsWith("/examples/dev/")) {
      response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      response.setHeader(
        "Permissions-Policy",
        'cross-origin-isolated=(self "https://noveltea.pages.dev")',
      );
    }
    response.setHeader("Cache-Control", "no-store");
    response.setHeader(
      "Content-Type",
      contentTypes.get(extname(path)) ?? "application/octet-stream",
    );
    response.writeHead(200);
    createReadStream(path).pipe(response);
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise())),
    );
  }
}

async function startPlayer(frame) {
  await frame.locator("#start").evaluate((button) => button.click());
  await frame.waitForFunction(
    () => typeof Reflect.get(window, "Module")?._noveltea_player_resize === "function",
    undefined,
    { timeout: 30_000 },
  );
  assert.notEqual(
    await frame.locator("#failure").evaluate((element) => getComputedStyle(element).display),
    "grid",
  );
}

test(
  "development showcase loads an explicit immutable PR preview without replacing production assets",
  { timeout: 90_000 },
  async () => {
    const sourceRevision = "c".repeat(40);
    const token = `pr-42/${sourceRevision}`;
    const prefix = `https://noveltea.pages.dev/examples/dev/preview-assets/${token}/`;
    const productionCatalog = JSON.parse(
      readFileSync(join(distRoot, "examples/dev/catalog.json"), "utf8"),
    );
    const previewCatalog = {
      format: "noveltea.example-preview",
      formatVersion: 1,
      prNumber: 42,
      source: {
        repository: "https://github.com/Cruel/noveltea-examples",
        revision: sourceRevision,
      },
      toolchain: {
        ntRevision: productionCatalog.toolchain.player.engineVersion.replace(/^dev-/, ""),
        player: {
          buildId: productionCatalog.toolchain.player.buildId,
          engineVersion: productionCatalog.toolchain.player.engineVersion,
        },
      },
      examples: productionCatalog.examples.map((example) => ({
        ...example,
        sourceUrl: `https://github.com/Cruel/noveltea-examples/tree/${sourceRevision}/projects/${example.id}`,
        projectUrl: `${prefix}artifacts/${example.id}.ntproject`,
        playerUrl: `${prefix}playable/${example.id}/index.html`,
      })),
    };

    await withServer(async (origin) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.route("https://noveltea.pages.dev/**", async (route) => {
          const requestUrl = new URL(route.request().url());
          const relative = requestUrl.pathname.split(`/examples/dev/preview-assets/${token}/`)[1];
          if (relative === "preview.json") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              headers: {
                "Access-Control-Allow-Origin": "*",
                "Cross-Origin-Resource-Policy": "cross-origin",
              },
              body: JSON.stringify(previewCatalog),
            });
            return;
          }
          const localPath = resolve(distRoot, "examples/dev/assets", relative ?? "");
          const assetRoot = resolve(distRoot, "examples/dev/assets");
          if (!localPath.startsWith(`${assetRoot}/`) || !existsSync(localPath)) {
            await route.fulfill({ status: 404, body: "Not found" });
            return;
          }
          const type = contentTypes.get(extname(localPath)) ?? "application/octet-stream";
          await route.fulfill({
            status: 200,
            contentType: type,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Cross-Origin-Resource-Policy": "cross-origin",
              ...(extname(localPath) === ".html"
                ? {
                    "Cross-Origin-Embedder-Policy": "require-corp",
                    "Cross-Origin-Opener-Policy": "same-origin",
                  }
                : {}),
            },
            body: readFileSync(localPath),
          });
        });

        await page.goto(`${origin}/examples/dev/?preview=${token}`, { waitUntil: "networkidle" });
        assert.equal(
          await page.locator("[data-example-channel]").textContent(),
          "Pull request preview #42",
        );
        assert.equal(
          await page.locator("[data-example-revision]").textContent(),
          sourceRevision.slice(0, 12),
        );
        assert.equal(await page.locator("[data-example-select]").count(), 2);
        assert.match(
          await page.locator("[data-example-project]").getAttribute("href"),
          new RegExp(`^${prefix}`),
        );

        const frame = page
          .frames()
          .find((candidate) => candidate.url() === `${prefix}playable/materials/index.html`);
        assert.ok(frame, "preview Materials player frame should load from the isolated namespace");
        assert.equal(await frame.evaluate(() => crossOriginIsolated), true);
        await startPlayer(frame);
      } finally {
        await browser.close();
      }
    });
  },
);

test(
  "development showcase runs both qualified players and recreates state when switching",
  { timeout: 90_000 },
  async () => {
    assert.equal(
      existsSync(join(distRoot, "examples/dev/index.html")),
      true,
      "build the site before browser tests",
    );

    await withServer(async (origin) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(`${origin}/examples/dev/`, { waitUntil: "networkidle" });
        assert.equal(await page.evaluate(() => crossOriginIsolated), true);
        assert.equal(
          await page
            .locator("[data-example-select]")
            .allTextContents()
            .then((items) => items.length),
          2,
        );

        const materialsFrameElement = await page
          .locator("iframe[data-example-player]")
          .elementHandle();
        const materialsFrame = page
          .frames()
          .find((frame) => frame.url().includes("/playable/materials/index.html"));
        assert.ok(materialsFrame, "Materials player frame should load");
        assert.equal(await materialsFrame.evaluate(() => crossOriginIsolated), true);
        await startPlayer(materialsFrame);

        const navigationUrl = page.url();
        await page.locator('[data-example-select="verbs"]').click();
        await page.waitForFunction(
          () => document.querySelector("[data-example-title]")?.textContent === "Verbs",
        );
        assert.equal(
          page.url(),
          navigationUrl,
          "switching examples must not navigate the surrounding site",
        );
        assert.equal(await materialsFrameElement.evaluate((element) => element.isConnected), false);

        const verbsFrame = page
          .frames()
          .find((frame) => frame.url().includes("/playable/verbs/index.html"));
        assert.ok(verbsFrame, "Verbs player frame should load");
        assert.equal(await verbsFrame.evaluate(() => crossOriginIsolated), true);
        await startPlayer(verbsFrame);

        assert.match(
          await page.locator("[data-example-source]").getAttribute("href"),
          /noveltea-examples\/tree\/[0-9a-f]{40}\/projects\/verbs$/,
        );
        assert.match(
          await page.locator("[data-example-project]").getAttribute("href"),
          /verbs\.ntproject$/,
        );

        await page.locator("[data-example-open]").click();
        await page.waitForFunction(() => !document.querySelector("[data-example-handoff]")?.hidden);
        assert.match(
          await page.locator("[data-example-handoff]").textContent(),
          /Browser handoff detection is only a heuristic/,
        );
      } finally {
        await browser.close();
      }
    });
  },
);
