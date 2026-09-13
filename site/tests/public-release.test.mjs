import assert from "node:assert/strict";
import { test } from "node:test";

import { groupAssetsByPlatform, parsePublicReleaseManifest } from "../src/lib/public-release.mjs";

const asset = (overrides = {}) => ({
  platform: "windows",
  arch: "x64",
  format: "installer",
  label: "Windows installer",
  primary: true,
  file: "noveltea-editor-v1.2.3-windows-x64-release.setup.exe",
  size: 123,
  sha256: "a".repeat(64),
  url: "https://github.com/Cruel/noveltea-releases/releases/download/v1.2.3/noveltea-editor-v1.2.3-windows-x64-release.setup.exe",
  ...overrides,
});

const manifest = () => ({
  format: "noveltea.public-release",
  version: 1,
  release: {
    tag: "v1.2.3",
    sourceRevision: "0".repeat(40),
    repository: "Cruel/noveltea-releases",
  },
  editor: [
    asset(),
    asset({
      platform: "linux",
      file: "linux.AppImage",
      url: "https://github.com/Cruel/noveltea-releases/releases/download/v1.2.3/linux.AppImage",
    }),
  ],
  cli: [
    asset({ file: "noveltea-v1.2.3-windows-x64.exe", format: "executable", label: "Windows x64" }),
  ],
  examples: {
    sourceRevision: "b".repeat(40),
    playerBuildId: "v1.2.3-web-wasm32-threads-release",
    archive: {
      format: "zip",
      label: "Release examples",
      file: "noveltea-examples-v1.2.3.zip",
      size: 456,
      sha256: "b".repeat(64),
      url: "https://github.com/Cruel/noveltea-releases/releases/download/v1.2.3/noveltea-examples-v1.2.3.zip",
    },
    metadata: {
      format: "json",
      label: "Release examples metadata",
      file: "noveltea-examples-v1.2.3.json",
      size: 123,
      sha256: "c".repeat(64),
      url: "https://github.com/Cruel/noveltea-releases/releases/download/v1.2.3/noveltea-examples-v1.2.3.json",
    },
  },
});

test("parses the current public release contract", () => {
  const parsed = parsePublicReleaseManifest(manifest());
  assert.equal(parsed.release.tag, "v1.2.3");
  assert.equal(parsed.editor.length, 2);
  assert.equal(parsed.examples.sourceRevision, "b".repeat(40));
  assert.equal(parsed.examples.playerBuildId, "v1.2.3-web-wasm32-threads-release");
  assert.deepEqual(
    groupAssetsByPlatform(parsed.editor).map(({ platform }) => platform),
    ["windows", "linux"],
  );
});

test("rejects downloads that do not resolve to the public distribution repository", () => {
  const value = manifest();
  value.editor[0].url = "https://github.com/Cruel/nt/releases/download/v1.2.3/editor.exe";
  assert.throws(() => parsePublicReleaseManifest(value), /invalid public download URL/);
});

test("rejects unsupported manifest versions", () => {
  const value = manifest();
  value.version = 2;
  assert.throws(
    () => parsePublicReleaseManifest(value),
    /Unsupported NovelTea public release manifest/,
  );
});

test("rejects release examples that do not match the public release", () => {
  const value = manifest();
  value.examples.playerBuildId = "v9.9.9-web-wasm32-threads-release";
  assert.throws(() => parsePublicReleaseManifest(value), /invalid examples identity/);
});
