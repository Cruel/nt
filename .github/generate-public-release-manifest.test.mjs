import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createPublicReleaseManifest } from "./generate-public-release-manifest.mjs";

test("public release manifest names exact public editor and CLI downloads", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "noveltea-release-manifest-"));
  const tag = "v1.2.3";
  const sourceRevision = "0".repeat(40);
  try {
    const names = [
      `noveltea-editor-${tag}-windows-x64-release.setup.exe`,
      `noveltea-editor-${tag}-linux-x64-release.AppImage`,
      `noveltea-editor-${tag}-linux-x64-release.deb`,
      `noveltea-editor-${tag}-linux-x64-release.rpm`,
      `noveltea-${tag}-windows-x64.zip`,
      `noveltea-${tag}-linux-x64.tar.gz`,
    ];
    for (const name of names) writeFileSync(path.join(root, name), name);
    writeFileSync(path.join(root, `noveltea-examples-${tag}.zip`), "examples");
    writeFileSync(
      path.join(root, `noveltea-examples-${tag}.json`),
      JSON.stringify({
        format: "noveltea.release-examples",
        version: 1,
        releaseTag: tag,
        ntRevision: sourceRevision,
        examplesRevision: "a".repeat(40),
        playerBuildId: `${tag}-web-wasm32-threads-release`,
        archive: `noveltea-examples-${tag}.zip`,
      }),
    );

    const manifest = createPublicReleaseManifest(root, tag, sourceRevision);

    assert.equal(manifest.format, "noveltea.public-release");
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.release, {
      tag,
      sourceRevision,
      repository: "Cruel/noveltea-releases",
    });
    assert.equal(manifest.editor.length, 4);
    assert.equal(manifest.cli.length, 2);
    assert.equal(manifest.examples.sourceRevision, "a".repeat(40));
    assert.equal(manifest.examples.playerBuildId, `${tag}-web-wasm32-threads-release`);
    assert.equal(manifest.examples.archive.file, `noveltea-examples-${tag}.zip`);
    assert.equal(manifest.editor[0].platform, "windows");
    assert.equal(manifest.editor[1].platform, "linux");
    assert.match(
      manifest.editor[0].url,
      /^https:\/\/github\.com\/Cruel\/noveltea-releases\/releases\/download\/v1\.2\.3\//,
    );
    for (const asset of [...manifest.editor, ...manifest.cli]) {
      assert.equal(asset.sha256.length, 64);
      assert.ok(asset.size > 0);
      assert.ok(names.includes(asset.file));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
