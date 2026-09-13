import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const releaseWorkflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = releaseWorkflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing release workflow job '${name}'`);
  const bodyStart = start + marker.length;
  const rest = releaseWorkflow.slice(bodyStart);
  const next = rest.search(/^  [a-z0-9-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

test("release examples use exact release CLI, player, and tagged examples pin", () => {
  const value = job("release-examples");
  assert.match(value, /needs: \[release-metadata, shader-assets, web\]/);
  assert.match(value, /noveltea-release-host-cli-linux-x64/);
  assert.match(value, /noveltea-web-release-dist/);
  assert.match(value, /examples\/noveltea-examples\.revision/);
  assert.match(value, /--player-engine-version "\$RELEASE_TAG"/);
  assert.match(value, /--player-build-id "\$\{RELEASE_TAG\}-web-wasm32-threads-release"/);
  assert.match(value, /noveltea-examples-\$\{RELEASE_TAG\}\.zip/);
});

test("release inventory cannot publish before release examples qualify", () => {
  const value = job("release-inventory");
  assert.match(value, /needs:\s*\n\s*\[[^\]]*release-examples[^\]]*\]/);
});
