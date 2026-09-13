#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(siteRoot, "..");
const manifestPath = resolve(repositoryRoot, "build/site-example-oversized/manifest.json");
const bucket = process.env.NOVELTEA_EXAMPLES_R2_BUCKET || "noveltea-artifacts";

if (!existsSync(manifestPath))
  throw new Error(`Oversized asset manifest not found: ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest?.format !== "noveltea.site-example-oversized-assets" ||
  manifest?.formatVersion !== 1 ||
  !Array.isArray(manifest.assets)
) {
  throw new Error("Invalid oversized development example asset manifest.");
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
}

process.stdout.write(
  `Uploaded ${manifest.assets.length} oversized development example asset(s).\n`,
);
