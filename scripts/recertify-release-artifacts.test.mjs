import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  HOSTS,
  availableArtifacts,
  inspectEditorFiles,
  requestedArtifacts,
  resolveRun,
} from "./recertify-release-artifacts.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const release = (id, sha = A) => ({
  id,
  path: ".github/workflows/release.yml",
  status: "completed",
  head_sha: sha,
  conclusion: "failure",
});
const artifact = (run, name, expired = false) => ({
  id:
    Math.abs(name.split("").reduce((total, char) => total * 31 + char.charCodeAt(0), 0)) %
    100_000_000,
  name,
  expired,
  workflow_run: { id: run.id, head_sha: run.head_sha },
});
function apiFor(runs, artifacts = {}, sha = A) {
  return async (endpoint) => {
    if (endpoint.startsWith("commits/")) return { sha };
    if (endpoint.match(/^actions\/runs\/\d+\/artifacts/)) {
      const id = Number(endpoint.split("/")[2]);
      return { artifacts: artifacts[id] ?? [] };
    }
    if (endpoint.match(/^actions\/runs\/\d+$/))
      return runs.find((run) => run.id === Number(endpoint.split("/")[2]));
    if (endpoint.startsWith("actions/workflows/release.yml/runs?")) {
      const wanted = new URLSearchParams(endpoint.split("?")[1]).get("head_sha");
      return { workflow_runs: runs.filter((run) => !wanted || run.head_sha === wanted) };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };
}

test("latest chooses newest completed run with an unexpired artifact in scope, not newest successful release", async () => {
  const runs = [release(42, B), release(41), release(40)];
  const api = apiFor(runs, {
    42: [artifact(runs[0], HOSTS[0].cli, true)],
    41: [artifact(runs[1], HOSTS[2].cli)],
    40: [artifact(runs[2], HOSTS[0].editor)],
  });
  const result = await resolveRun({ api });
  assert.equal(result.run.id, 41);
  assert.deepEqual(result.present, [HOSTS[2].cli]);
  assert.equal(result.missing.length, 5);
});

test("commit SHA resolves to an exact GitHub commit and selects only its release artifacts", async () => {
  const runs = [release(44, B), release(43)];
  const result = await resolveRun({
    source: "sha",
    sha: "aaaaaaa",
    scope: "editor",
    api: apiFor(runs, { 43: [artifact(runs[1], HOSTS[0].editor)] }),
  });
  assert.equal(result.run.id, 43);
  assert.deepEqual(result.present, [HOSTS[0].editor]);
});

test("explicit run ID accepts a failed Release with CLI artifacts", async () => {
  const run = release(51);
  const result = await resolveRun({
    source: "run",
    runId: "51",
    scope: "cli",
    api: apiFor([run], { 51: [artifact(run, HOSTS[1].cli)] }),
  });
  assert.equal(result.run.id, 51);
  assert.deepEqual(result.present, [HOSTS[1].cli]);
});

test("rejects unrelated workflow, incomplete runs, mismatched artifact SHA, and expired-only selections", async () => {
  const run = release(52);
  await assert.rejects(
    resolveRun({
      source: "run",
      runId: "52",
      api: apiFor([{ ...run, path: ".github/workflows/build.yml" }]),
    }),
    /completed NovelTea Release/,
  );
  await assert.rejects(
    resolveRun({ source: "run", runId: "52", api: apiFor([{ ...run, status: "in_progress" }]) }),
    /completed NovelTea Release/,
  );
  await assert.rejects(
    resolveRun({
      source: "run",
      runId: "52",
      api: apiFor([run], {
        52: [{ ...artifact(run, HOSTS[0].cli), workflow_run: { id: 52, head_sha: B } }],
      }),
    }),
    /different source commit/,
  );
  await assert.rejects(
    resolveRun({
      source: "run",
      runId: "52",
      api: apiFor([run], {
        52: [artifact(run, HOSTS[0].cli, true)],
      }),
    }),
    /no downloadable artifacts/,
  );
  assert.throws(
    () => availableArtifacts(run, [artifact(run, HOSTS[0].cli), artifact(run, HOSTS[0].cli)]),
    /Duplicate/,
  );
});

test("invalid source arguments are rejected before any GitHub API lookup", async () => {
  const api = async () => {
    throw new Error("API must not be called");
  };
  await assert.rejects(resolveRun({ source: "run", runId: "../123", api }), /numeric/);
  await assert.rejects(resolveRun({ source: "sha", sha: "branch-name", api }), /hexadecimal/);
  await assert.rejects(resolveRun({ source: "latest", runId: "123", api }), /only valid/);
  assert.deepEqual(
    requestedArtifacts("cli"),
    HOSTS.map((host) => host.cli),
  );
});

test("editor installer inspection reads magic signatures, verifies complete platform set, and hashes bytes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nt-editor-artifact-test-"));
  try {
    for (const [name, prefix, footer] of [
      ["NovelTea-Editor-1.0.0-linux-x86_64.AppImage", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
      ["NovelTea-Editor-1.0.0-linux-amd64.deb", Buffer.from("!<arch>\n")],
      ["NovelTea-Editor-1.0.0-linux-x86_64.rpm", Buffer.from([0xed, 0xab, 0xee, 0xdb])],
      ["NovelTea-Editor-1.0.0-win-x64.exe", Buffer.from("MZ")],
      ["NovelTea-Editor-1.0.0-mac-arm64.dmg", Buffer.alloc(4), Buffer.from("koly")],
      ["NovelTea-Editor-1.0.0-mac-arm64.zip", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ]) {
      const bytes = Buffer.alloc(1024);
      prefix.copy(bytes);
      if (footer) footer.copy(bytes, bytes.length - 512);
      await writeFile(path.join(directory, name), bytes);
    }
    assert.equal((await inspectEditorFiles(directory, "linux-x64")).length, 3);
    assert.equal((await inspectEditorFiles(directory, "windows-x64")).length, 1);
    assert.equal((await inspectEditorFiles(directory, "macos-arm64")).length, 2);
    await writeFile(
      path.join(directory, "NovelTea-Editor-1.0.0-linux-x86_64.rpm"),
      Buffer.alloc(1024),
    );
    await assert.rejects(inspectEditorFiles(directory, "linux-x64"), /signature mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
