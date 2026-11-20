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

test("Release uses native system dependencies only for genuine export/package checks", () => {
  assert.doesNotMatch(job("shader-assets"), /setup-linux-vcpkg|cmake --build/);
  assert.match(job("shader-assets"), /candidate: linux-release-cli-x64/);
  assert.doesNotMatch(job("web"), /setup-linux-vcpkg|cmake --build|emcmake/);
  assert.match(job("web"), /restore-release-candidate/);
  const desktopHosts = job("desktop-hosts");
  assert.match(desktopHosts, /uses: \.\/\.github\/actions\/setup-linux-native/);
  assert.match(desktopHosts, /graphics: "true"/);
  assert.match(desktopHosts, /xvfb: "true"/);
  assert.match(desktopHosts, /extra-packages: weston libgl1-mesa-dri/);
  const android = job("android");
  assert.match(android, /setup-linux-native/);
  assert.match(android, /sdkmanager/);
  assert.match(job("desktop-editor"), /setup-linux-native/);
  assert.match(job("desktop-editor"), /rpm fakeroot/);
  assert.doesNotMatch(releaseWorkflow, /apt-get (?:update|install)/);
});

test("Release never recompiles a cold native CLI; source-owned Build is its only producer", () => {
  const shaderAssets = job("shader-assets");
  assert.match(shaderAssets, /Restore the Debian ABI-floor native CLI/);
  assert.match(shaderAssets, /candidate: linux-release-cli-x64/);
  assert.match(shaderAssets, /build-run-id:/);
  assert.match(shaderAssets, /NOVELTEA_MAX_GLIBC_VERSION=2\.36/);
  assert.doesNotMatch(shaderAssets, /vcpkg install|bzip2|cmake --build|noveltea:build/);
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

test("Windows desktop release restores and uses the exact Build Windows CLI Licenses viewer runner", () => {
  const desktop = job("desktop-hosts");
  assert.match(desktop, /candidate: windows-release-cli-x64/);
  assert.match(desktop, /NOVELTEA_LICENSE_VIEWER_RUNNER:.*build\\cli\\windows\\noveltea-ui-test-runner\.exe/);
  assert.match(desktop, /tests\/native_cli\/windows_release_smoke\.py/);
  assert.match(desktop, /build\/cli\/windows\/noveltea\.exe/);
});

test("release builds leave compile concurrency automatic like regular CI", () => {
  assert.doesNotMatch(releaseWorkflow, /CMAKE_BUILD_PARALLEL_LEVEL:/);
  assert.doesNotMatch(releaseWorkflow, /VCPKG_MAX_CONCURRENCY:/);
});

test("Build retains isolated Debian and glibc 2.28 producers while Release independently enforces the ABI floors", () => {
  const build = readFileSync(new URL("../../.github/workflows/build.yml", import.meta.url), "utf8");
  assert.match(build, /linux-player-glibc228\.Dockerfile/);
  assert.match(build, /VCPKG_TARGET_TRIPLET=x64-linux-noveltea/);
  assert.match(build, /NOVELTEA_MAX_GLIBC_VERSION=2\.28/);
  assert.match(job("shader-assets"), /NOVELTEA_MAX_GLIBC_VERSION=2\.36/);
  assert.match(job("desktop-hosts"), /NOVELTEA_MAX_GLIBC_VERSION=2\.28/);
  assert.match(job("desktop-hosts"), /NOVELTEA_REQUIRE_STATIC_GNU_CXX_RUNTIME=ON/);
  assert.match(job("desktop-hosts"), /candidate: linux-player-x64-release/);
  assert.doesNotMatch(job("desktop-hosts"), /cmake --build|linux-player-glibc228\.Dockerfile/);
  for (const tool of ["curl", "tar", "unzip", "zip"])
    assert.match(linuxPlayerDockerfile, new RegExp("\\b"+tool+"\\b"));
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
