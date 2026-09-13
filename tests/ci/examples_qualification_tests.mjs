import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parseExamplesRevision,
  validateQualifiedExamplesCatalog,
} from "../../scripts/qualify-examples.mjs";

const revision = "76c7eacddd2acf6704e089b99f12d00c3dd60926";
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
