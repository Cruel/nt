import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const releaseWorkflow = readFileSync(
  new URL("../../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const linuxPlayerDockerfile = readFileSync(
  new URL("../../.github/containers/linux-player-glibc228.Dockerfile", import.meta.url),
  "utf8",
);
const vcpkgManifest = JSON.parse(
  readFileSync(new URL("../../vcpkg.json", import.meta.url), "utf8"),
);
const rootCMake = readFileSync(new URL("../../CMakeLists.txt", import.meta.url), "utf8");
const bgfxGlibcPatch = readFileSync(
  new URL("../../cmake/patch-bgfx-glibc228.cmake", import.meta.url),
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

test("release workflow pins source checkouts to the triggering commit", () => {
  assert.match(releaseWorkflow, /RELEASE_REF: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(releaseWorkflow, /RELEASE_REF: \$\{\{ github\.ref \}\}/);
  for (const name of [
    "release-metadata",
    "shader-assets",
    "windows-cli",
    "desktop-hosts",
    "web",
    "release-examples",
    "android",
    "desktop-editor",
    "release-inventory",
    "publish",
  ]) {
    assert.match(job(name), /ref: \$\{\{ env\.RELEASE_REF \}\}/);
  }
});

test("release examples use exact release CLI, player, and tagged examples pin", () => {
  const value = job("release-examples");
  assert.match(value, /needs: \[release-metadata, shader-assets, web\]/);
  assert.match(value, /noveltea-release-host-cli-linux-x64/);
  assert.match(value, /chmod \+x[\s\S]*?build\/release-examples-toolchain\/noveltea-ui-test-runner[\s\S]*?build\/release-examples-toolchain\/tools\/ffmpeg\/bin\/ffmpeg/);
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

test("cold release CLI builds retry verified bzip2 downloads before vcpkg install", () => {
  const shaderAssets = job("shader-assets");
  const seed = shaderAssets.indexOf("name: Seed checksum-pinned bzip2 source with retries");
  const build = shaderAssets.indexOf("name: Build NovelTea host CLI");
  assert.ok(seed >= 0 && seed < build);
  const sourceStep = shaderAssets.slice(seed, build);
  assert.match(sourceStep, /bzip2-1\.0\.8\.tar\.gz/);
  assert.match(sourceStep, /sourceware\.org/);
  assert.match(sourceStep, /mirrorservice\.org/);
  assert.match(sourceStep, /--retry-all-errors/);
  assert.match(sourceStep, /sha512sum --check --status/);
  assert.match(sourceStep, /mv "\$staged" "\$archive"/);
});

test("Android ARM64 devtools certification checks APK and AAB release artifacts", () => {
  const android = job("android");
  const start = android.indexOf(
    "- name: Export and inspect optimized ARM64 developer APK plus AAB through public CLI",
  );
  const end = android.indexOf("- name: Generate Android platform certification reports", start);
  assert.ok(start >= 0 && end > start);
  const exportStep = android.slice(start, end);
  assert.match(exportStep, /NOVELTEA_ANDROID_FLAVOR: release/);
  assert.match(exportStep, /NOVELTEA_CANONICAL_PLAYER_VARIANT: devtools/);
  assert.match(exportStep, /NOVELTEA_ANDROID_ARTIFACT: both/);
  assert.match(exportStep, /--flavor release --variant devtools --artifact both/);
});

test("Windows desktop release variants use their matching Licenses viewer runner", () => {
  const desktopHosts = job("desktop-hosts");
  const start = desktopHosts.indexOf("- name: Finalize and launch Windows portable export");
  const end = desktopHosts.indexOf(
    "- name: Finalize and launch Linux portable export on X11",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const exportStep = desktopHosts.slice(start, end);
  assert.match(
    exportStep,
    /NOVELTEA_LICENSE_VIEWER_RUNNER: \$\{\{ github\.workspace \}\}\\build\\\$\{\{ matrix\.preset \}\}\\tools\\editor_tool\\noveltea-ui-test-runner\.exe/,
  );
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
  for (const tool of ["curl", "tar", "unzip", "zip"]) {
    assert.match(linuxPlayerDockerfile, new RegExp(`\\b${tool}\\b`));
  }
});

test("Linux player keeps DBus systemd-free and patches bx to the glibc 2.28 floor", () => {
  const dbusDependency = vcpkgManifest.dependencies.find(
    (dependency) => typeof dependency === "object" && dependency.name === "dbus",
  );
  assert.deepEqual(dbusDependency, {
    name: "dbus",
    "default-features": false,
    platform: "linux",
  });
  assert.match(rootCMake, /patch-bgfx-glibc228\.cmake/g);
  assert.match(bgfxGlibcPatch, /BX_CRT_GLIBC >= 22800/);
  assert.match(bgfxGlibcPatch, /BX_CRT_GLIBC >= 23100/);
});

test("release inventory cannot publish before release examples qualify", () => {
  const value = job("release-inventory");
  assert.match(value, /needs:\s*\n\s*\[[^\]]*release-examples[^\]]*\]/);
});
