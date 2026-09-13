import { readFileSync } from "node:fs";
import path from "node:path";

const SUPPORTED_PLATFORMS = new Set(["windows", "linux"]);

function parsePublicAsset(value, collection) {
  if (!value || typeof value !== "object")
    throw new Error(`${collection} release asset must be an object.`);
  for (const key of ["format", "label", "file", "url", "sha256"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`${collection} release asset is missing '${key}'.`);
    }
  }
  if (!Number.isSafeInteger(value.size) || value.size < 0) {
    throw new Error(`${collection} release asset has invalid size.`);
  }
  const parsedUrl = new URL(value.url);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    !parsedUrl.pathname.startsWith("/Cruel/noveltea-releases/releases/download/")
  ) {
    throw new Error(`${collection} release asset has an invalid public download URL.`);
  }
  return value;
}

function parseAsset(value, collection) {
  parsePublicAsset(value, collection);
  for (const key of ["platform", "arch"]) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`${collection} release asset is missing '${key}'.`);
    }
  }
  if (!SUPPORTED_PLATFORMS.has(value.platform)) {
    throw new Error(`${collection} release asset uses unsupported platform '${value.platform}'.`);
  }
  if (typeof value.primary !== "boolean") {
    throw new Error(`${collection} release asset is missing primary flag.`);
  }
  return value;
}

export function parsePublicReleaseManifest(value) {
  if (!value || typeof value !== "object") throw new Error("Release manifest must be an object.");
  if (value.format !== "noveltea.public-release" || value.version !== 1) {
    throw new Error("Unsupported NovelTea public release manifest.");
  }
  const release = value.release;
  if (
    !release ||
    typeof release !== "object" ||
    typeof release.tag !== "string" ||
    !/^[0-9a-f]{40}$/.test(release.sourceRevision ?? "") ||
    release.repository !== "Cruel/noveltea-releases"
  ) {
    throw new Error("Release manifest has invalid release identity.");
  }
  if (!Array.isArray(value.editor) || !Array.isArray(value.cli)) {
    throw new Error("Release manifest must contain editor and CLI asset arrays.");
  }
  const examples = value.examples;
  if (
    !examples ||
    typeof examples !== "object" ||
    !/^[0-9a-f]{40}$/.test(examples.sourceRevision ?? "") ||
    examples.playerBuildId !== `${release.tag}-web-wasm32-threads-release`
  ) {
    throw new Error("Release manifest has invalid examples identity.");
  }
  return {
    format: value.format,
    version: value.version,
    release,
    editor: value.editor.map((asset) => parseAsset(asset, "Editor")),
    cli: value.cli.map((asset) => parseAsset(asset, "CLI")),
    examples: {
      sourceRevision: examples.sourceRevision,
      playerBuildId: examples.playerBuildId,
      archive: parsePublicAsset(examples.archive, "Examples archive"),
      metadata: parsePublicAsset(examples.metadata, "Examples metadata"),
    },
  };
}

export function loadPublicReleaseManifest(
  manifestPath = process.env.NOVELTEA_RELEASE_MANIFEST_PATH,
) {
  if (!manifestPath) return null;
  const resolved = path.resolve(manifestPath);
  return parsePublicReleaseManifest(JSON.parse(readFileSync(resolved, "utf8")));
}

export function groupAssetsByPlatform(assets) {
  return ["windows", "linux"]
    .map((platform) => ({
      platform,
      assets: assets.filter((asset) => asset.platform === platform),
    }))
    .filter(({ assets }) => assets.length > 0);
}
