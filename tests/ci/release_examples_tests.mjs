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

test("release Linux jobs reuse the shared native dependency setup", () => {
  for (const name of ["shader-assets", "web", "release-examples", "android"]) {
    assert.match(job(name), /uses: \.\/\.github\/actions\/setup-linux-native/);
  }

  const desktopHosts = job("desktop-hosts");
  assert.match(desktopHosts, /uses: \.\/\.github\/actions\/setup-linux-native/);
  assert.match(desktopHosts, /graphics: "true"/);
  assert.match(desktopHosts, /xvfb: "true"/);
  assert.match(desktopHosts, /extra-packages: weston libgl1-mesa-dri/);

  const desktopEditor = job("desktop-editor");
  assert.match(desktopEditor, /uses: \.\/\.github\/actions\/setup-linux-native/);
  assert.match(desktopEditor, /xvfb: "true"/);
  assert.doesNotMatch(releaseWorkflow, /apt-get (?:update|install)/);
});

test("release builds leave compile concurrency automatic like regular CI", () => {
  assert.doesNotMatch(releaseWorkflow, /CMAKE_BUILD_PARALLEL_LEVEL:/);
  assert.doesNotMatch(releaseWorkflow, /VCPKG_MAX_CONCURRENCY:/);
});

test("release Linux compatibility environments are isolated and reject SDL without X11", () => {
  const shaderAssets = job("shader-assets");
  assert.match(shaderAssets, /node:24\.18\.0-bookworm@sha256:/);
  assert.match(shaderAssets, /name: Set up vcpkg/);
  assert.match(shaderAssets, /uses: \.\/\.github\/actions\/setup-linux-vcpkg/);
  assert.match(shaderAssets, /scope: linux-authoring-release/);
  assert.match(shaderAssets, /binary-scope: linux-authoring-release/);
  assert.match(shaderAssets, /cache-prefix: debian-12-glibc-2\.36-x64/);
  assert.match(shaderAssets, /NOVELTEA_MAX_GLIBC_VERSION=2\.36/);
  assert.doesNotMatch(shaderAssets, /\$\{\{ github\.workspace \}\}/);
  assert.doesNotMatch(shaderAssets, /vcpkg-common/);

  const desktopHosts = job("desktop-hosts");
  assert.match(desktopHosts, /linux-player-glibc228\.Dockerfile/);
  assert.match(desktopHosts, /manylinux-2\.28-x64-player-/);
  assert.match(desktopHosts, /NOVELTEA_MAX_GLIBC_VERSION=2\.28/);
  assert.match(desktopHosts, /NOVELTEA_REQUIRE_STATIC_GNU_CXX_RUNTIME=ON/);
  assert.match(desktopHosts, /name: Verify SDL3 X11 backend is present/);
  assert.match(desktopHosts, /SDL_x11video\\\.c\\\.o/);
});

test("release inventory cannot publish before release examples qualify", () => {
  const value = job("release-inventory");
  assert.match(value, /needs:\s*\n\s*\[[^\]]*release-examples[^\]]*\]/);
});
