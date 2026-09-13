#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultPinPath = resolve(repositoryRoot, "examples/noveltea-examples.revision");
const examplesRepository = "https://github.com/Cruel/noveltea-examples";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} must be an existing regular file: ${path}`);
  }
}

function generatedPath(outputRoot, catalogPath) {
  if (typeof catalogPath !== "string" || !catalogPath || isAbsolute(catalogPath)) {
    throw new Error("Qualified example catalog contains an invalid generated artifact path");
  }
  const resolved = resolve(outputRoot, catalogPath);
  const rel = relative(outputRoot, resolved);
  if (!rel || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`Qualified example artifact escapes output root: ${catalogPath}`);
  }
  return resolved;
}

function assertArtifactMetadata(metadata, label) {
  if (
    !metadata ||
    typeof metadata.path !== "string" ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 1 ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256)
  ) {
    throw new Error(`Qualified examples must contain complete generated artifacts (${label})`);
  }
}

function verifyArtifact(outputRoot, metadata, label) {
  assertArtifactMetadata(metadata, label);
  const path = generatedPath(outputRoot, metadata.path);
  assertRegularFile(path, label);
  if (statSync(path).size !== metadata.size || sha256File(path) !== metadata.sha256) {
    throw new Error(`Qualified example artifact does not match catalog metadata: ${metadata.path}`);
  }
}

export function parseExamplesRevision(text) {
  if (typeof text !== "string" || !/^[0-9a-f]{40}\n?$/.test(text)) {
    throw new Error("NovelTea examples pin must be an exact lowercase 40-character Git commit SHA");
  }
  return text.trimEnd();
}

export function validateQualifiedExamplesCatalog(
  catalog,
  {
    revision,
    ntRevision,
    cliSha256,
    playerTemplateSha256,
    playerDescriptorSha256,
    playerEngineVersion = `dev-${ntRevision}`,
    playerBuildId = `dev-${ntRevision}-web-wasm32-threads-release`,
  },
) {
  if (
    catalog?.format !== "noveltea.example-catalog" ||
    catalog?.formatVersion !== 1 ||
    catalog?.source?.repository !== examplesRepository ||
    catalog?.source?.revision !== revision
  ) {
    throw new Error("Qualified catalog does not match the pinned examples revision");
  }

  if (
    catalog?.toolchain?.cli?.sha256 !== cliSha256 ||
    catalog?.toolchain?.player?.templateArchive?.sha256 !== playerTemplateSha256 ||
    catalog?.toolchain?.player?.descriptor?.sha256 !== playerDescriptorSha256 ||
    catalog?.toolchain?.player?.templateId !== "web-wasm32-threads-release" ||
    catalog?.toolchain?.player?.engineVersion !== playerEngineVersion ||
    catalog?.toolchain?.player?.buildId !== playerBuildId ||
    !Array.isArray(catalog?.toolchain?.player?.files) ||
    catalog.toolchain.player.files.length === 0
  ) {
    throw new Error("Qualified catalog does not match the exact NovelTea toolchain");
  }

  const playerExtensions = new Set();
  for (const file of catalog.toolchain.player.files) {
    assertArtifactMetadata(file, "shared player file");
    if (!file.path.startsWith("player/")) {
      throw new Error("Qualified catalog shared player files must stay under player/");
    }
    const match = /\.(wasm|js|data)$/.exec(file.path);
    if (match) playerExtensions.add(match[1]);
  }
  if (!["wasm", "js", "data"].every((extension) => playerExtensions.has(extension))) {
    throw new Error("Qualified catalog must contain one complete shared Web player");
  }

  if (!Array.isArray(catalog.examples)) {
    throw new Error("Qualified examples must contain Materials and Verbs");
  }
  const ids = new Set(catalog.examples.map((example) => example?.id));
  if (!ids.has("materials") || !ids.has("verbs")) {
    throw new Error("Qualified examples must contain Materials and Verbs");
  }

  for (const example of catalog.examples) {
    const artifacts = example?.artifacts;
    try {
      if (example?.source?.revision !== revision) throw new Error("source revision mismatch");
      assertArtifactMetadata(
        artifacts?.runtimePackage,
        `${example?.id ?? "unknown"} runtime package`,
      );
      assertArtifactMetadata(
        artifacts?.projectBundle,
        `${example?.id ?? "unknown"} project bundle`,
      );
      if (
        typeof artifacts?.playable?.path !== "string" ||
        !Array.isArray(artifacts?.playable?.files) ||
        artifacts.playable.files.length === 0
      ) {
        throw new Error("missing playable files");
      }
      for (const file of artifacts.playable.files) {
        assertArtifactMetadata(file, `${example?.id ?? "unknown"} playable file`);
      }
    } catch {
      throw new Error("Qualified examples must contain complete generated artifacts");
    }
  }

  return catalog;
}

export function verifyQualifiedExamplesOutput(outputRoot, catalog) {
  for (const file of catalog.toolchain.player.files) {
    verifyArtifact(outputRoot, file, "shared player file");
  }
  for (const example of catalog.examples) {
    verifyArtifact(outputRoot, example.artifacts.runtimePackage, `${example.id} runtime package`);
    verifyArtifact(outputRoot, example.artifacts.projectBundle, `${example.id} project bundle`);
    for (const file of example.artifacts.playable.files) {
      verifyArtifact(outputRoot, file, `${example.id} playable file`);
    }
  }
}

function usage() {
  return `Usage: node scripts/qualify-examples.mjs \\
  --examples-root <noveltea-examples checkout> \\
  --nt-revision <40-character nt commit> \\
  --cli <noveltea> \\
  --player-template <threaded Web template.zip> \\
  --player-descriptor <template.json> \\
  --output <directory> \\
  [--pin <revision file>] \\
  [--player-engine-version <version>] \\
  [--player-build-id <build-id>]\n`;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") return { help: true };
    if (
      ![
        "--examples-root",
        "--nt-revision",
        "--cli",
        "--player-template",
        "--player-descriptor",
        "--output",
        "--pin",
        "--player-engine-version",
        "--player-build-id",
      ].includes(name)
    ) {
      throw new Error(`Unknown argument '${name}'.\n\n${usage()}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for '${name}'.\n\n${usage()}`);
    if (values.has(name)) throw new Error(`Argument '${name}' may be provided only once.`);
    values.set(name, value);
    index += 1;
  }
  for (const required of [
    "--examples-root",
    "--nt-revision",
    "--cli",
    "--player-template",
    "--player-descriptor",
    "--output",
  ]) {
    if (!values.has(required))
      throw new Error(`Missing required argument '${required}'.\n\n${usage()}`);
  }
  return {
    help: false,
    examplesRoot: resolve(values.get("--examples-root")),
    ntRevision: values.get("--nt-revision"),
    cli: resolve(values.get("--cli")),
    playerTemplate: resolve(values.get("--player-template")),
    playerDescriptor: resolve(values.get("--player-descriptor")),
    output: resolve(values.get("--output")),
    pin: resolve(values.get("--pin") ?? defaultPinPath),
    playerEngineVersion: values.get("--player-engine-version"),
    playerBuildId: values.get("--player-build-id"),
  };
}

function runGit(examplesRoot, args) {
  return execFileSync("git", ["-C", examplesRoot, ...args], { encoding: "utf8" }).trim();
}

export function qualifyExamples({
  examplesRoot,
  ntRevision,
  cli,
  playerTemplate,
  playerDescriptor,
  output,
  pin,
  playerEngineVersion = `dev-${ntRevision}`,
  playerBuildId = `dev-${ntRevision}-web-wasm32-threads-release`,
}) {
  assertRegularFile(pin, "Examples revision pin");
  if (!/^[0-9a-f]{40}$/.test(ntRevision)) {
    throw new Error("NovelTea revision must be an exact lowercase 40-character Git commit SHA");
  }
  assertRegularFile(cli, "NovelTea CLI");
  assertRegularFile(playerTemplate, "Threaded Web player template");
  assertRegularFile(playerDescriptor, "Threaded Web player descriptor");

  const revision = parseExamplesRevision(readFileSync(pin, "utf8"));
  const checkoutRevision = runGit(examplesRoot, ["rev-parse", "HEAD"]);
  if (checkoutRevision !== revision) {
    throw new Error(`Examples checkout is ${checkoutRevision}, but nt pins ${revision}`);
  }
  const dirty = runGit(examplesRoot, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) {
    throw new Error(
      "Examples checkout must be clean so qualification uses only the pinned revision",
    );
  }

  const builder = resolve(examplesRoot, "scripts/build-examples.mjs");
  assertRegularFile(builder, "Shared examples build entrypoint");
  execFileSync(
    process.execPath,
    [
      builder,
      "--cli",
      cli,
      "--player-template",
      playerTemplate,
      "--player-descriptor",
      playerDescriptor,
      "--source-revision",
      revision,
      "--output",
      output,
    ],
    { cwd: examplesRoot, stdio: "inherit", env: process.env },
  );

  const catalogPath = resolve(output, "catalog.json");
  assertRegularFile(catalogPath, "Generated examples catalog");
  const catalog = validateQualifiedExamplesCatalog(JSON.parse(readFileSync(catalogPath, "utf8")), {
    revision,
    ntRevision,
    cliSha256: sha256File(cli),
    playerTemplateSha256: sha256File(playerTemplate),
    playerDescriptorSha256: sha256File(playerDescriptor),
    playerEngineVersion,
    playerBuildId,
  });
  verifyQualifiedExamplesOutput(output, catalog);
  return { revision, catalogPath };
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  const result = qualifyExamples(args);
  process.stdout.write(`Qualified NovelTea examples ${result.revision} into ${args.output}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
