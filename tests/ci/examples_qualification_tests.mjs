import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parseExamplesRevision,
  validateQualifiedExamplesCatalog,
} from "../../scripts/qualify-examples.mjs";

const revision = "e5a8bc3ee7fc70473a8e52807e541f0da1e608eb";
const ntRevision = "4".repeat(40);
const digest = (character) => character.repeat(64);

function catalog() {
  return {
    format: "noveltea.example-catalog",
    formatVersion: 1,
    source: {
      repository: "https://github.com/Cruel/noveltea-examples",
      revision,
    },
    toolchain: {
      cli: {
        version: "0.1.0",
        path: "toolchain/noveltea",
        size: 100,
        sha256: digest("a"),
      },
      player: {
        templateId: "web-wasm32-threads-release",
        buildId: `dev-${ntRevision}-web-wasm32-threads-release`,
        engineVersion: `dev-${ntRevision}`,
        compiledProjectFormatVersion: 1,
        playerRuntimeApiVersion: 1,
        templateArchive: {
          path: "toolchain/player-template.zip",
          size: 200,
          sha256: digest("b"),
        },
        descriptor: {
          path: "toolchain/player-template.json",
          size: 300,
          sha256: digest("c"),
        },
        files: [
          { path: "player/player.aaa.wasm", size: 10, sha256: digest("4") },
          { path: "player/player.aaa.js", size: 11, sha256: digest("5") },
          { path: "player/player.aaa.data", size: 12, sha256: digest("6") },
        ],
      },
    },
    examples: [
      {
        id: "materials",
        source: { revision },
        artifacts: {
          runtimePackage: { path: "artifacts/materials.ntpkg", size: 1, sha256: digest("d") },
          projectBundle: { path: "artifacts/materials.ntproject", size: 1, sha256: digest("e") },
          playable: {
            path: "playable/materials",
            files: [{ path: "playable/materials/index.html", size: 1, sha256: digest("f") }],
          },
        },
      },
      {
        id: "verbs",
        source: { revision },
        artifacts: {
          runtimePackage: { path: "artifacts/verbs.ntpkg", size: 1, sha256: digest("1") },
          projectBundle: { path: "artifacts/verbs.ntproject", size: 1, sha256: digest("2") },
          playable: {
            path: "playable/verbs",
            files: [{ path: "playable/verbs/index.html", size: 1, sha256: digest("3") }],
          },
        },
      },
    ],
  };
}

function expectedToolchain(overrides = {}) {
  return {
    revision,
    ntRevision,
    cliSha256: digest("a"),
    playerTemplateSha256: digest("b"),
    playerDescriptorSha256: digest("c"),
    ...overrides,
  };
}

test("examples revision pin is an exact commit", () => {
  const pinned = readFileSync(
    new URL("../../examples/noveltea-examples.revision", import.meta.url),
    "utf8",
  );
  assert.equal(parseExamplesRevision(pinned), revision);
  assert.equal(parseExamplesRevision(`${revision}\n`), revision);
  assert.throws(
    () => parseExamplesRevision("main\n"),
    /exact lowercase 40-character Git commit SHA/,
  );
  assert.throws(
    () => parseExamplesRevision(`${revision}\nextra\n`),
    /exact lowercase 40-character Git commit SHA/,
  );
});

test("qualified catalog must match the pinned examples revision and exact toolchain", () => {
  const value = catalog();
  assert.equal(validateQualifiedExamplesCatalog(value, expectedToolchain()), value);

  assert.throws(
    () => validateQualifiedExamplesCatalog(value, expectedToolchain({ revision: "0".repeat(40) })),
    /pinned examples revision/,
  );
  assert.throws(
    () => validateQualifiedExamplesCatalog(value, expectedToolchain({ cliSha256: digest("9") })),
    /exact NovelTea toolchain/,
  );
  assert.throws(
    () =>
      validateQualifiedExamplesCatalog(value, expectedToolchain({ ntRevision: "5".repeat(40) })),
    /exact NovelTea toolchain/,
  );
});

test("site CI consumes qualified examples through native workflow dependencies", () => {
  const buildWorkflow = readFileSync(
    new URL("../../.github/workflows/build.yml", import.meta.url),
    "utf8",
  );
  const siteWorkflow = readFileSync(
    new URL("../../.github/workflows/site.yml", import.meta.url),
    "utf8",
  );
  const releaseSiteWorkflow = readFileSync(
    new URL("../../.github/workflows/site-release.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    buildWorkflow,
    /\n  site:\n[\s\S]*?needs: examples\n[\s\S]*?uses: \.\/\.github\/workflows\/site\.yml/,
  );
  assert.match(siteWorkflow, /workflow_call:/);
  assert.match(siteWorkflow, /name: noveltea-development-examples/);
  assert.doesNotMatch(siteWorkflow, /gh run list|sleep 20|deadline=/);

  assert.match(releaseSiteWorkflow, /workflows: \[Release\]/);
  assert.match(releaseSiteWorkflow, /gh run list[\s\S]*--status success/);
  assert.doesNotMatch(releaseSiteWorkflow, /while \[|sleep 20|deadline=/);
  assert.match(releaseSiteWorkflow, /uses: \.\/\.github\/workflows\/site\.yml/);
});

test("qualified catalog accepts an exact release player identity", () => {
  const value = catalog();
  value.toolchain.player.engineVersion = "v1.2.3";
  value.toolchain.player.buildId = "v1.2.3-web-wasm32-threads-release";
  assert.equal(
    validateQualifiedExamplesCatalog(
      value,
      expectedToolchain({
        playerEngineVersion: "v1.2.3",
        playerBuildId: "v1.2.3-web-wasm32-threads-release",
      }),
    ),
    value,
  );
});

test("qualified catalog requires both initial examples and complete artifacts", () => {
  const missingExample = catalog();
  missingExample.examples.pop();
  assert.throws(
    () => validateQualifiedExamplesCatalog(missingExample, expectedToolchain()),
    /Materials and Verbs/,
  );

  const emptyPlayable = catalog();
  emptyPlayable.examples[0].artifacts.playable.files = [];
  assert.throws(
    () => validateQualifiedExamplesCatalog(emptyPlayable, expectedToolchain()),
    /complete generated artifacts/,
  );

  const wrongSource = catalog();
  wrongSource.examples[0].source.revision = "0".repeat(40);
  assert.throws(
    () => validateQualifiedExamplesCatalog(wrongSource, expectedToolchain()),
    /complete generated artifacts/,
  );
});
