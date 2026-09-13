#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(siteRoot, "..");
const developmentManifestPath = resolve(
  repositoryRoot,
  "build/site-example-oversized/manifest.json",
);
if (!existsSync(developmentManifestPath)) {
  throw new Error(
    `Oversized development example asset manifest not found: ${developmentManifestPath}`,
  );
}
const releaseManifestPath = resolve(
  repositoryRoot,
  "build/site-example-oversized-release/manifest.json",
);
const manifestPaths = [
  developmentManifestPath,
  ...(existsSync(releaseManifestPath) ? [releaseManifestPath] : []),
];
const bucket = process.env.NOVELTEA_EXAMPLES_R2_BUCKET || "noveltea-artifacts";

let uploaded = 0;
for (const manifestPath of manifestPaths) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest?.format !== "noveltea.site-example-oversized-assets" ||
    manifest?.formatVersion !== 1 ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error(`Invalid oversized development example asset manifest: ${manifestPath}`);
  }

  for (const asset of manifest.assets) {
    if (
      typeof asset?.key !== "string" ||
      typeof asset?.sourcePath !== "string" ||
      typeof asset?.contentType !== "string" ||
      !Number.isSafeInteger(asset?.size) ||
      asset.size < 1 ||
      !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")
    ) {
      throw new Error("Invalid oversized development example asset entry.");
    }
    const source = resolve(asset.sourcePath);
    if (!existsSync(source) || !statSync(source).isFile() || statSync(source).size !== asset.size) {
      throw new Error(`Oversized development example asset is missing: ${source}`);
    }
    process.stdout.write(`Uploading ${asset.key} (${asset.size} bytes)...\n`);
    execFileSync(
      "pnpm",
      [
        "-C",
        "site",
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `${bucket}/${asset.key}`,
        "--file",
        source,
        "--content-type",
        asset.contentType,
        "--cache-control",
        "public, max-age=604800, immutable",
        "--remote",
        "--force",
      ],
      { cwd: repositoryRoot, stdio: "inherit", env: process.env },
    );
    uploaded += 1;
  }
}

process.stdout.write(`Uploaded ${uploaded} oversized example asset(s).\n`);
