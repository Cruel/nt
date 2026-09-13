import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultCatalogPath = resolve(siteRoot, "../build/site-examples/catalog.json");
const defaultAssetBase = "/examples/dev/assets";
const examplesRepository = "https://github.com/Cruel/noveltea-examples";
const preparedCatalogPath = resolve(siteRoot, "public/examples/dev/catalog.json");

function cleanAssetBase(value) {
  const base = value?.trim() || defaultAssetBase;
  return base.replace(/\/+$/, "");
}

function assertArtifact(value, label) {
  if (
    !value ||
    typeof value.path !== "string" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 1 ||
    !/^[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw new Error(`Invalid development example ${label}.`);
  }
}

export function loadQualifiedDevelopmentExamples(
  catalogPath = process.env.NOVELTEA_EXAMPLES_CATALOG_PATH || defaultCatalogPath,
) {
  const resolvedCatalogPath = resolve(catalogPath);
  const catalog = JSON.parse(readFileSync(resolvedCatalogPath, "utf8"));
  if (
    catalog?.format !== "noveltea.example-catalog" ||
    catalog?.formatVersion !== 1 ||
    catalog?.source?.repository !== examplesRepository ||
    !/^[0-9a-f]{40}$/.test(catalog?.source?.revision ?? "") ||
    catalog?.toolchain?.player?.templateId !== "web-wasm32-threads-release" ||
    !Array.isArray(catalog.examples)
  ) {
    throw new Error("Invalid qualified development examples catalog.");
  }

  const ids = new Set(catalog.examples.map((example) => example?.id));
  if (!ids.has("materials") || !ids.has("verbs")) {
    throw new Error("Development example catalog must contain Materials and Verbs.");
  }

  for (const example of catalog.examples) {
    assertArtifact(example?.artifacts?.projectBundle, `${example?.id ?? "unknown"} project bundle`);
    if (
      example?.source?.revision !== catalog.source.revision ||
      typeof example?.source?.path !== "string" ||
      !Array.isArray(example?.artifacts?.playable?.files) ||
      example.artifacts.playable.files.length === 0
    ) {
      throw new Error(`Invalid development example entry '${example?.id ?? "unknown"}'.`);
    }
  }

  return { catalog, catalogPath: resolvedCatalogPath, artifactRoot: dirname(resolvedCatalogPath) };
}

export function createDevelopmentExampleShowcaseModel(
  catalog,
  { assetBase = process.env.NOVELTEA_EXAMPLES_ASSET_BASE_URL } = {},
) {
  const base = cleanAssetBase(assetBase);
  return {
    format: "noveltea.site-example-catalog",
    formatVersion: 1,
    channel: "dev",
    source: catalog.source,
    toolchain: {
      player: {
        templateId: catalog.toolchain.player.templateId,
        buildId: catalog.toolchain.player.buildId,
        engineVersion: catalog.toolchain.player.engineVersion,
      },
    },
    examples: catalog.examples.map((example) => ({
      id: example.id,
      title: example.title,
      description: example.description,
      highlights: example.highlights,
      sourceUrl: `${examplesRepository}/tree/${catalog.source.revision}/${example.source.path}`,
      projectUrl: `${base}/${example.artifacts.projectBundle.path}`,
      projectSha256: example.artifacts.projectBundle.sha256,
      playerUrl: `${base}/players/${encodeURIComponent(example.id)}/index.html`,
    })),
  };
}

export function loadDevelopmentExampleShowcaseModel(catalog) {
  if (existsSync(preparedCatalogPath)) {
    const prepared = JSON.parse(readFileSync(preparedCatalogPath, "utf8"));
    if (
      prepared?.format !== "noveltea.site-example-catalog" ||
      prepared?.formatVersion !== 1 ||
      prepared?.source?.revision !== catalog.source.revision ||
      !Array.isArray(prepared.examples)
    ) {
      throw new Error("Invalid prepared development example catalog.");
    }
    return prepared;
  }
  return createDevelopmentExampleShowcaseModel(catalog);
}

export const developmentExamplesDefaults = {
  catalogPath: defaultCatalogPath,
  assetBase: defaultAssetBase,
};
