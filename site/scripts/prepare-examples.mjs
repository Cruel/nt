#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prepare = resolve(siteRoot, "scripts/prepare-development-examples.mjs");

function run(env) {
  execFileSync(process.execPath, [prepare], {
    cwd: siteRoot,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

run({ NOVELTEA_EXAMPLES_PUBLIC_ROUTE: "/examples/dev" });

const releaseCatalog = process.env.NOVELTEA_RELEASE_EXAMPLES_CATALOG_PATH?.trim();
if (releaseCatalog) {
  run({
    NOVELTEA_EXAMPLES_PUBLIC_ROUTE: "/examples",
    NOVELTEA_EXAMPLES_CATALOG_PATH: releaseCatalog,
    NOVELTEA_EXAMPLES_R2_KEY_PREFIX: process.env.NOVELTEA_RELEASE_EXAMPLES_R2_KEY_PREFIX ?? "",
    NOVELTEA_EXAMPLES_R2_BASE_URL: process.env.NOVELTEA_RELEASE_EXAMPLES_R2_BASE_URL ?? "",
  });
} else {
  const releasePublicRoot = resolve(siteRoot, "public/examples");
  rmSync(resolve(releasePublicRoot, "assets"), { recursive: true, force: true });
  rmSync(resolve(releasePublicRoot, "catalog.json"), { force: true });
  rmSync(resolve(siteRoot, "../build/site-example-public-release"), {
    recursive: true,
    force: true,
  });
  rmSync(resolve(siteRoot, "../build/site-example-oversized-release"), {
    recursive: true,
    force: true,
  });
}
