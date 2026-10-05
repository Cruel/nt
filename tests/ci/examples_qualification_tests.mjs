import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  parseExamplesRevision,
  validateQualifiedExamplesCatalog,
  aggregateQualifiedExamples,
} from "../../scripts/qualify-examples.mjs";

const revision = "1".repeat(40);
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
        source: { revision, path: "projects/materials" },
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
        source: { revision, path: "projects/verbs" },
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

test("publication qualifies independent producers before sharing one player", () => {
  const root = mkdtempSync(resolve(tmpdir(), "nt-publication-test-"));
  try {
    const external = catalog();
    const lab = catalog();
    lab.source = { repository: "https://github.com/Cruel/nt", revision: ntRevision };
    lab.examples = [
      {
        ...lab.examples[0],
        id: "feature-lab",
        source: { revision: ntRevision, path: "tests/projects/feature-lab" },
        artifacts: {
          runtimePackage: { path: "artifacts/feature-lab.ntpkg" },
          projectBundle: { path: "artifacts/feature-lab.ntproject" },
          playable: {
            path: "playable/feature-lab",
            files: [{ path: "playable/feature-lab/index.html" }],
          },
        },
      },
    ];
    const producers = [external, lab].map((value, index) => {
      const outputRoot = resolve(root, String(index));
      const files = [
        ...value.toolchain.player.files,
        ...value.examples.flatMap((example) => [
          example.artifacts.runtimePackage,
          example.artifacts.projectBundle,
          ...example.artifacts.playable.files,
        ]),
      ];
      for (const file of files) {
        const path = resolve(outputRoot, file.path);
        mkdirSync(dirname(path), { recursive: true });
        const bytes = Buffer.from(file.path);
        writeFileSync(path, bytes);
        file.size = bytes.length;
        file.sha256 = createHash("sha256").update(bytes).digest("hex");
      }
      return {
        catalog: value,
        outputRoot,
        expected: expectedToolchain({
          revision: value.source.revision,
          repository: value.source.repository,
          requiredIds: value.examples.map((example) => example.id),
        }),
      };
    });
    const output = resolve(root, "publication");
    const result = aggregateQualifiedExamples({ producers, output, ntRevision });
    assert.equal(result.format, "noveltea.publication-catalog");
    assert.equal(result.publication.ntRevision, ntRevision);
    assert.deepEqual(
      result.examples.map((example) => example.id),
      ["materials", "verbs", "feature-lab"],
    );
    assert.equal(result.examples[2].source.repository, "https://github.com/Cruel/nt");
    assert.equal(result.examples[2].source.revision, ntRevision);
    assert.equal(result.examples[2].source.path, "tests/projects/feature-lab");
    assert.equal(result.examples[2].sourceUrl, undefined);
    assert.match(result.examples[0].sourceUrl, /noveltea-examples\/tree/);
    assert.equal(result.toolchain.player.files.length, 3);
    assert.equal(
      readFileSync(resolve(output, "artifacts/feature-lab.ntproject"), "utf8"),
      "artifacts/feature-lab.ntproject",
    );
    lab.toolchain.player.files[0].sha256 = digest("9");
    assert.throws(() => aggregateQualifiedExamples({ producers, output, ntRevision }), /artifact/);
    const alteredPlayer = Buffer.from("different but accurately catalogued player");
    const playerFile = lab.toolchain.player.files[0];
    writeFileSync(resolve(producers[1].outputRoot, playerFile.path), alteredPlayer);
    playerFile.size = alteredPlayer.length;
    playerFile.sha256 = createHash("sha256").update(alteredPlayer).digest("hex");
    assert.throws(
      () => aggregateQualifiedExamples({ producers, output, ntRevision }),
      /exact shared Web player/,
    );
    assert.equal(
      readFileSync(resolve(output, "artifacts/feature-lab.ntproject"), "utf8"),
      "artifacts/feature-lab.ntproject",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("examples revision pin is an exact commit", () => {
  const pinned = readFileSync(
    new URL("../../examples/noveltea-examples.revision", import.meta.url),
    "utf8",
  );
  assert.match(parseExamplesRevision(pinned), /^[0-9a-f]{40}$/u);
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
    /required example IDs/,
  );

  const emptyPlayable = catalog();
  emptyPlayable.examples[0].artifacts.playable.files = [];
  assert.throws(
    () => validateQualifiedExamplesCatalog(emptyPlayable, expectedToolchain()),
    /complete generated artifacts/,
  );

  const duplicatedPlayer = catalog();
  duplicatedPlayer.examples[0].artifacts.playable.files.push({
    path: "playable/materials/player.aaa.wasm",
    size: 10,
    sha256: digest("4"),
  });
  assert.throws(
    () => validateQualifiedExamplesCatalog(duplicatedPlayer, expectedToolchain()),
    /complete generated artifacts/,
  );

  const wrongSource = catalog();
  wrongSource.examples[0].source.revision = "0".repeat(40);
  assert.throws(
    () => validateQualifiedExamplesCatalog(wrongSource, expectedToolchain()),
    /complete generated artifacts/,
  );
});
