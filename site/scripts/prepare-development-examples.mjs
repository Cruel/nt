#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDevelopmentExampleShowcaseModel,
  loadQualifiedDevelopmentExamples,
} from "../src/lib/development-examples.mjs";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoute = process.env.NOVELTEA_EXAMPLES_PUBLIC_ROUTE?.trim() || "/examples/dev";
if (!/^\/examples(?:\/dev)?$/.test(publicRoute)) {
  throw new Error(`Unsupported examples public route: ${publicRoute}`);
}
const channelId = publicRoute === "/examples/dev" ? "development" : "release";
const stagedRoot = resolve(
  siteRoot,
  channelId === "development"
    ? "../build/site-example-public"
    : "../build/site-example-public-release",
);
const oversizedRoot = resolve(
  siteRoot,
  channelId === "development"
    ? "../build/site-example-oversized"
    : "../build/site-example-oversized-release",
);
const publicRoot = resolve(siteRoot, `public${publicRoute}`);
const publicAssetRoot = resolve(publicRoot, "assets");
const pagesFileLimit =
  Number.parseInt(process.env.NOVELTEA_PAGES_FILE_LIMIT_BYTES || "", 10) || 25 * 1024 * 1024;
const localMode = process.env.NOVELTEA_EXAMPLES_LOCAL === "1";
const r2BaseUrl = process.env.NOVELTEA_EXAMPLES_R2_BASE_URL?.trim()?.replace(/\/+$/, "");
const r2KeyPrefix = process.env.NOVELTEA_EXAMPLES_R2_KEY_PREFIX?.trim()?.replace(/^\/+|\/+$/g, "");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyFile(root, metadata) {
  const source = resolve(root, metadata.path);
  const rel = relative(root, source);
  if (
    !rel ||
    rel.startsWith("../") ||
    statSync(source).size !== metadata.size ||
    sha256(source) !== metadata.sha256
  ) {
    throw new Error(`Qualified example artifact failed verification: ${metadata.path}`);
  }
  return source;
}

function writePreparedFile(source, destination, transform = undefined) {
  mkdirSync(dirname(destination), { recursive: true });
  if (!transform) {
    cpSync(source, destination);
    return;
  }
  writeFileSync(destination, transform(readFileSync(source, "utf8")), "utf8");
}

function contentType(path) {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".ntproject")) return "application/octet-stream";
  return "application/octet-stream";
}

function remoteUrl(path) {
  if (!r2BaseUrl)
    throw new Error(`Oversized development example asset requires R2 placement: ${path}`);
  return `${r2BaseUrl}/${path}`;
}

const { catalog, artifactRoot } = loadQualifiedDevelopmentExamples();
const assetBase = `${publicRoute}/assets`;
const model = createDevelopmentExampleShowcaseModel(catalog, {
  assetBase,
  channel: channelId === "development" ? "dev" : "release",
});
const modelById = new Map(model.examples.map((example) => [example.id, example]));

rmSync(stagedRoot, { recursive: true, force: true });
rmSync(oversizedRoot, { recursive: true, force: true });
rmSync(publicAssetRoot, { recursive: true, force: true });
rmSync(resolve(publicRoot, "catalog.json"), { force: true });
mkdirSync(stagedRoot, { recursive: true });
mkdirSync(oversizedRoot, { recursive: true });
mkdirSync(publicRoot, { recursive: true });

const oversized = [];
const placement = (path, metadata) => {
  if (localMode || metadata.size <= pagesFileLimit) return `${assetBase}/${path}`;
  const url = remoteUrl(path);
  if (!r2KeyPrefix)
    throw new Error("NOVELTEA_EXAMPLES_R2_KEY_PREFIX is required for R2 placement.");
  oversized.push({
    path,
    key: `${r2KeyPrefix}/${path}`,
    sourcePath: resolve(oversizedRoot, path),
    url,
    size: metadata.size,
    sha256: metadata.sha256,
    contentType: contentType(path),
  });
  return url;
};

const sharedPlayerFiles = new Map();
for (const metadata of catalog.toolchain.player.files) {
  const source = verifyFile(artifactRoot, metadata);
  if (!metadata.path.startsWith("player/")) {
    throw new Error(`Shared player file escaped player directory: ${metadata.path}`);
  }
  const relativePlayerPath = metadata.path.slice("player/".length);
  const url = placement(metadata.path, metadata);
  sharedPlayerFiles.set(relativePlayerPath, { metadata, source, url });
  if (localMode || metadata.size <= pagesFileLimit) {
    writePreparedFile(source, resolve(stagedRoot, metadata.path));
  } else {
    writePreparedFile(source, resolve(oversizedRoot, metadata.path));
  }
}

for (const example of catalog.examples) {
  const view = modelById.get(example.id);
  const projectSource = verifyFile(artifactRoot, example.artifacts.projectBundle);
  const projectPath = example.artifacts.projectBundle.path;
  view.projectUrl = placement(projectPath, example.artifacts.projectBundle);
  if (localMode || example.artifacts.projectBundle.size <= pagesFileLimit) {
    writePreparedFile(projectSource, resolve(stagedRoot, projectPath));
  } else {
    writePreparedFile(projectSource, resolve(oversizedRoot, projectPath));
  }

  const playablePrefix = `${example.artifacts.playable.path}/`;
  const playableFiles = new Map();
  for (const metadata of example.artifacts.playable.files) {
    const source = verifyFile(artifactRoot, metadata);
    if (!metadata.path.startsWith(playablePrefix)) {
      throw new Error(
        `Playable file escaped '${example.artifacts.playable.path}': ${metadata.path}`,
      );
    }
    const playableRelative = metadata.path.slice(playablePrefix.length);
    const publicPath = metadata.path;
    playableFiles.set(playableRelative, {
      metadata,
      source,
      publicPath,
      url: placement(publicPath, metadata),
    });
  }

  for (const [playableRelative, file] of playableFiles) {
    if (!localMode && file.metadata.size > pagesFileLimit) {
      writePreparedFile(file.source, resolve(oversizedRoot, file.publicPath));
      continue;
    }
    const transform =
      playableRelative === "index.html"
        ? (html) => {
            let rebased = html.replaceAll('"/', '"./').replaceAll("'/", "'./");
            for (const [relativePath, candidate] of playableFiles) {
              if (!candidate.url.startsWith("http")) continue;
              rebased = rebased
                .replaceAll(`"./${relativePath}"`, `"${candidate.url}"`)
                .replaceAll(`'./${relativePath}'`, `'${candidate.url}'`);
            }
            for (const [relativePath, candidate] of sharedPlayerFiles) {
              if (!candidate.url.startsWith("http")) continue;
              rebased = rebased
                .replaceAll(`"../../player/${relativePath}"`, `"${candidate.url}"`)
                .replaceAll(`'../../player/${relativePath}'`, `'${candidate.url}'`);
            }
            return rebased;
          }
        : undefined;
    writePreparedFile(file.source, resolve(stagedRoot, file.publicPath), transform);
  }
}

writeFileSync(resolve(stagedRoot, "catalog.json"), `${JSON.stringify(model, null, 2)}\n`, "utf8");
writeFileSync(
  resolve(oversizedRoot, "manifest.json"),
  `${JSON.stringify({ format: "noveltea.site-example-oversized-assets", formatVersion: 1, assets: oversized }, null, 2)}\n`,
  "utf8",
);

cpSync(stagedRoot, publicAssetRoot, { recursive: true });
writeFileSync(resolve(publicRoot, "catalog.json"), `${JSON.stringify(model, null, 2)}\n`, "utf8");

process.stdout.write(
  `Prepared ${catalog.examples.length} development examples (${oversized.length} oversized asset${oversized.length === 1 ? "" : "s"}${localMode ? ", local mode" : ""}).\n`,
);
