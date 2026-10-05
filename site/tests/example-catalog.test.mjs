import assert from "node:assert/strict";
import { test } from "node:test";
import { createDevelopmentExampleShowcaseModel } from "../src/lib/development-examples.mjs";

test("public showcase exposes Play and Project without private provenance or runtime downloads", () => {
  const catalog = {
    publication: { ntRevision: "a".repeat(40) },
    source: { repository: "https://github.com/Cruel/noveltea-examples", revision: "b".repeat(40) },
    toolchain: {
      player: {
        templateId: "web-wasm32-threads-release",
        buildId: "release-player",
        engineVersion: "v1.0.0",
      },
    },
    examples: [
      {
        id: "feature-lab",
        title: "Feature Lab",
        description: "Reference Project",
        highlights: [],
        source: {
          repository: "https://github.com/Cruel/nt",
          revision: "a".repeat(40),
          path: "tests/projects/feature-lab",
        },
        artifacts: {
          runtimePackage: { path: "artifacts/feature-lab.ntpkg" },
          projectBundle: { path: "artifacts/feature-lab.ntproject", sha256: "c".repeat(64) },
          playable: { path: "playable/feature-lab" },
        },
      },
    ],
  };
  const model = createDevelopmentExampleShowcaseModel(catalog);
  assert.equal(Object.hasOwn(model.examples[0], "sourceUrl"), false);
  assert.match(model.examples[0].projectUrl, /feature-lab\.ntproject$/);
  assert.match(model.examples[0].playerUrl, /playable\/feature-lab\/index.html$/);
  assert.doesNotMatch(JSON.stringify(model), /Cruel\/nt|tests\/projects|\.ntpkg/);
  const sourceUrl = "https://github.com/Cruel/noveltea-examples/tree/public/projects/example";
  const publicCatalog = { ...catalog, examples: [{ ...catalog.examples[0], sourceUrl }] };
  assert.equal(
    createDevelopmentExampleShowcaseModel(publicCatalog).examples[0].sourceUrl,
    sourceUrl,
  );
});
