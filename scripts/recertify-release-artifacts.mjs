#!/usr/bin/env node

// Resolve immutable artifacts from one completed Release workflow run. No
// compiler, packager, or generation step is involved in this entrypoint.
import { createReadStream } from "node:fs";
import { appendFile, readdir, open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HOSTS = Object.freeze([
  {
    platform: "linux-x64",
    cli: "noveltea-release-host-cli-linux-x64",
    editor: "noveltea-desktop-editor-linux-x64-release-dist",
  },
  {
    platform: "windows-x64",
    cli: "noveltea-release-host-cli-windows-x64",
    editor: "noveltea-desktop-editor-windows-x64-release-dist",
  },
  {
    platform: "macos-arm64",
    cli: "noveltea-release-host-cli-macos-arm64",
    editor: "noveltea-desktop-editor-macos-arm64-release-dist",
  },
]);

const SHA = /^[a-f\d]{40}$/i;
const SHORT_SHA = /^[a-f\d]{7,40}$/i;
const RUN = /^[1-9]\d*$/;

export function requestedArtifacts(scope) {
  if (!["all", "cli", "editor"].includes(scope))
    throw new Error("scope must be all, cli, or editor.");
  return HOSTS.flatMap((host) => [
    ...(scope !== "editor" ? [host.cli] : []),
    ...(scope !== "cli" ? [host.editor] : []),
  ]);
}

export function validateReleaseRun(run) {
  if (
    !Number.isSafeInteger(run?.id) ||
    run?.path !== ".github/workflows/release.yml" ||
    run?.status !== "completed" ||
    !SHA.test(run?.head_sha ?? "")
  )
    throw new Error(
      "Selected run must be a completed NovelTea Release workflow with an exact commit.",
    );
  return run;
}

export function availableArtifacts(run, artifacts) {
  const available = new Set();
  for (const item of artifacts) {
    if (item.expired) continue;
    if (item.workflow_run?.id !== undefined && item.workflow_run.id !== run.id)
      throw new Error(`Artifact ${item.name} belongs to a different workflow run.`);
    if (item.workflow_run?.head_sha && item.workflow_run.head_sha !== run.head_sha)
      throw new Error(`Artifact ${item.name} has a different source commit.`);
    if (typeof item.name !== "string" || !Number.isSafeInteger(item.id))
      throw new Error("Malformed Actions artifact metadata.");
    if (available.has(item.name)) throw new Error(`Duplicate release artifact: ${item.name}`);
    available.add(item.name);
  }
  return available;
}

export async function resolveRun({ source = "latest", runId = "", sha = "", scope = "all", api }) {
  const wanted = requestedArtifacts(scope);
  if (!["latest", "sha", "run"].includes(source))
    throw new Error("source must be latest, sha, or run.");
  if (source === "run" && !RUN.test(String(runId)))
    throw new Error("Enter a numeric Release run ID.");
  if (source === "sha" && !SHORT_SHA.test(sha))
    throw new Error("Enter a 7–40-character hexadecimal commit SHA.");
  if (source !== "run" && runId) throw new Error("runId is only valid with source=run.");
  if (source !== "sha" && sha) throw new Error("sha is only valid with source=sha.");

  const fullSha = source === "sha" ? (await api(`commits/${sha}`)).sha : null;
  if (source === "sha" && !SHA.test(fullSha ?? ""))
    throw new Error("Could not resolve commit SHA.");

  async function inspect(run) {
    validateReleaseRun(run);
    const artifactList = [];
    for (let page = 1; page <= 20; page++) {
      const result = await api(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
      const items = result.artifacts ?? [];
      artifactList.push(...items);
      if (items.length < 100) break;
      if (page === 20) throw new Error("Artifact listing exceeds safe pagination limit.");
    }
    const available = availableArtifacts(run, artifactList);
    const present = wanted.filter((name) => available.has(name));
    return { run, present, missing: wanted.filter((name) => !available.has(name)) };
  }

  if (source === "run") {
    const result = await inspect(await api(`actions/runs/${runId}`));
    if (!result.present.length)
      throw new Error("The selected run has no downloadable artifacts for this scope.");
    return result;
  }
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({ status: "completed", per_page: "100", page: String(page) });
    if (fullSha) query.set("head_sha", fullSha);
    const runs = (await api(`actions/workflows/release.yml/runs?${query}`)).workflow_runs ?? [];
    for (const run of runs) {
      if (fullSha && run.head_sha !== fullSha) continue;
      const result = await inspect(run);
      if (result.present.length) return result;
    }
    if (runs.length < 100) break;
  }
  throw new Error("No completed Release run with downloadable artifacts matches this selection.");
}

export async function githubApi(endpoint, repository, token = process.env.GH_TOKEN) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid repository.");
  if (!token) throw new Error("GH_TOKEN is required for artifact resolution.");
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status} while reading ${endpoint}.`);
  return response.json();
}

const MAGIC = {
  deb: { bytes: Buffer.from("!<arch>\n"), offset: 0 },
  rpm: { bytes: Buffer.from([0xed, 0xab, 0xee, 0xdb]), offset: 0 },
  AppImage: { bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), offset: 0 },
  exe: { bytes: Buffer.from("MZ"), offset: 0 },
  dmg: { bytes: Buffer.from("koly"), offset: -512 },
  zip: { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset: 0 },
};
const EXTENSIONS = {
  "linux-x64": ["AppImage", "deb", "rpm"],
  "windows-x64": ["exe"],
  "macos-arm64": ["dmg", "zip"],
};
const NAMES = {
  "linux-x64": /-linux-(?:x64|amd64|x86_64)\./i,
  "windows-x64": /-(?:win|windows)-x64\./i,
  "macos-arm64": /-mac-arm64\./i,
};

export async function inspectEditorFiles(directory, platform) {
  const required = EXTENSIONS[platform];
  if (!required) throw new Error(`Unsupported editor platform: ${platform}`);
  const names = (await readdir(directory)).filter(
    (name) => name.startsWith("NovelTea-Editor-") && NAMES[platform].test(name),
  );
  const results = [];
  for (const extension of required) {
    const matches = names.filter((name) => name.endsWith(`.${extension}`));
    if (matches.length !== 1)
      throw new Error(
        `Expected exactly one ${platform} .${extension} editor distributable; found ${matches.length}.`,
      );
    const filename = path.join(directory, matches[0]);
    const info = await stat(filename);
    if (!info.isFile() || info.size <= 512)
      throw new Error(`Empty or invalid editor distributable: ${matches[0]}`);
    const fd = await open(filename, "r");
    try {
      const { bytes, offset } = MAGIC[extension];
      const actual = Buffer.alloc(bytes.length);
      const { bytesRead } = await fd.read(
        actual,
        0,
        bytes.length,
        offset < 0 ? info.size + offset : offset,
      );
      if (bytesRead !== bytes.length || !actual.equals(bytes))
        throw new Error(`Editor ${extension} signature mismatch: ${matches[0]}`);
    } finally {
      await fd.close();
    }
    const sha256 = createHash("sha256");
    for await (const chunk of createReadStream(filename)) sha256.update(chunk);
    results.push({ name: matches[0], bytes: info.size, sha256: sha256.digest("hex") });
  }
  return results;
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? "" : (process.argv[index + 1] ?? "");
}

async function main() {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) return;
  const operation = process.argv[2];
  if (operation === "resolve") {
    const repository = process.env.GITHUB_REPOSITORY || "Cruel/nt";
    const selection = await resolveRun({
      source: arg("source") || "latest",
      runId: arg("run-id"),
      sha: arg("sha"),
      scope: arg("scope") || "all",
      api: (endpoint) => githubApi(endpoint, repository),
    });
    const { run, present, missing } = selection;
    const output =
      [
        `run_id=${run.id}`,
        `sha=${run.head_sha}`,
        `artifacts=${JSON.stringify(present)}`,
        `scope=${arg("scope") || "all"}`,
      ].join("\n") + "\n";
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### Artifact source\n\n- Release run: [${run.id}](${run.html_url}) (${run.conclusion})\n- Source commit: \`${run.head_sha}\`\n- Downloadable selected artifacts: ${present.length}\n- Unavailable/expired: ${missing.length ? missing.join(", ") : "none"}\n- No build or packaging will run.\n\n`,
      );
    console.log(
      `Release ${run.id} @ ${run.head_sha}: ${present.length} downloadable, ${missing.length} unavailable.`,
    );
  } else if (operation === "verify-editor") {
    const platform = arg("platform");
    const files = await inspectEditorFiles(arg("directory") || "dist", platform);
    console.log(JSON.stringify({ platform, files }, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### ${platform}: Editor installer integrity\n\n${files.map((f) => `- ${f.name} — ${f.bytes} bytes, SHA-256 \`${f.sha256}\``).join("\n")}\n\n`,
      );
  } else {
    throw new Error("Usage: recertify-release-artifacts.mjs resolve|verify-editor [--options].");
  }
}

await main();
