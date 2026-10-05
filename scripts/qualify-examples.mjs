#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
    repository = examplesRepository,
    requiredIds = ["materials", "verbs"],
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
    catalog?.source?.repository !== repository ||
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
    throw new Error("Qualified examples must contain all required example IDs exactly once");
  }
  const ids = new Set(catalog.examples.map((example) => example?.id));
  if (ids.size !== catalog.examples.length || requiredIds.some((id) => !ids.has(id))) {
    throw new Error("Qualified examples must contain all required example IDs exactly once");
  }

  for (const example of catalog.examples) {
    const artifacts = example?.artifacts;
    try {
      if (
        example?.source?.revision !== revision ||
        typeof example?.source?.path !== "string" ||
        !example.source.path ||
        isAbsolute(example.source.path) ||
        example.source.path.split("/").includes("..")
      )
        throw new Error("source provenance mismatch");
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
        if (/^player\..+\.(?:wasm|js|data)$/.test(basename(file.path))) {
          throw new Error("playable export duplicates the shared player");
        }
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

export function aggregateQualifiedExamples({ producers, output, ntRevision }) {
  if (!/^[0-9a-f]{40}$/.test(ntRevision) || producers.length !== 2) {
    throw new Error("Publication requires an exact nt revision and both qualified producers");
  }
  for (const producer of producers) {
    validateQualifiedExamplesCatalog(producer.catalog, producer.expected);
    verifyQualifiedExamplesOutput(producer.outputRoot, producer.catalog);
  }
  const [external, lab] = producers;
  if (
    external.catalog.source.repository !== examplesRepository ||
    lab.catalog.source.repository !== "https://github.com/Cruel/nt" ||
    lab.catalog.source.revision !== ntRevision ||
    lab.catalog.examples.length !== 1 ||
    lab.catalog.examples[0].id !== "feature-lab" ||
    producers.some((producer) => producer.expected.ntRevision !== ntRevision) ||
    !isDeepStrictEqual(external.catalog.toolchain, lab.catalog.toolchain)
  ) {
    throw new Error("Publication producers must use the exact shared Web player and toolchain");
  }
  const catalog = {
    format: "noveltea.publication-catalog",
    publication: { ntRevision },
    source: external.catalog.source,
    toolchain: external.catalog.toolchain,
    examples: [],
  };
  const paths = new Set();
  const ids = new Set();
  const copy = (root, file) => {
    if (paths.has(file.path)) throw new Error(`Duplicate publication artifact: ${file.path}`);
    paths.add(file.path);
    const destination = generatedPath(output, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(generatedPath(root, file.path), destination);
  };
  rmSync(output, { recursive: true, force: true });
  for (const file of catalog.toolchain.player.files) copy(external.outputRoot, file);
  for (const producer of producers) {
    for (const example of producer.catalog.examples) {
      if (ids.has(example.id)) throw new Error(`Duplicate publication example: ${example.id}`);
      ids.add(example.id);
      const entry = {
        id: example.id,
        order: example.order,
        title: example.title,
        description: example.description,
        highlights: example.highlights,
        artifacts: example.artifacts,
        source: { ...example.source, repository: producer.catalog.source.repository },
        ...(producer === external
          ? {
              sourceUrl: `${examplesRepository}/tree/${example.source.revision}/${example.source.path}`,
            }
          : {}),
      };
      catalog.examples.push(entry);
      for (const file of [
        example.artifacts.runtimePackage,
        example.artifacts.projectBundle,
        ...example.artifacts.playable.files,
      ])
        copy(producer.outputRoot, file);
    }
  }
  verifyQualifiedExamplesOutput(output, catalog);
  writeFileSync(resolve(output, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
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

  if (runGit(repositoryRoot, ["rev-parse", "HEAD"]) !== ntRevision) {
    throw new Error("Feature Lab checkout must match the publication nt revision");
  }
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
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), "nt-publication-"));
  try {
    const externalOutput = resolve(temporaryRoot, "external");
    const labOutput = resolve(temporaryRoot, "lab");
    const labSource = resolve(temporaryRoot, "lab-source");
    mkdirSync(resolve(labSource, "projects"), { recursive: true });
    cpSync(
      resolve(repositoryRoot, "tests/projects/feature-lab"),
      resolve(labSource, "projects/feature-lab"),
      {
        recursive: true,
        filter: (path) => ![".noveltea", ".git", "dist"].includes(basename(path)),
      },
    );
    writeFileSync(
      resolve(labSource, "examples.json"),
      JSON.stringify({
        format: "noveltea.examples",
        formatVersion: 1,
        repository: "https://github.com/Cruel/nt",
        examples: [
          {
            id: "feature-lab",
            order: 3,
            title: "Feature Lab",
            description: "Explore NovelTea's authored runtime features in one reference Project.",
            sourcePath: "projects/feature-lab",
            highlights: [
              "Isolated feature scenarios",
              "Authored semantic and UI checks",
              "Editable reference Project",
            ],
          },
        ],
      }),
    );
    const buildProducer = (producerOutput, sourceRevision, sourceRoot) =>
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
          sourceRevision,
          "--output",
          producerOutput,
        ],
        {
          cwd: examplesRoot,
          stdio: "inherit",
          env: { ...process.env, NOVELTEA_EXAMPLES_SOURCE_ROOT: sourceRoot },
        },
      );
    buildProducer(externalOutput, revision, examplesRoot);
    buildProducer(labOutput, ntRevision, labSource);
    const expected = {
      ntRevision,
      cliSha256: sha256File(cli),
      playerTemplateSha256: sha256File(playerTemplate),
      playerDescriptorSha256: sha256File(playerDescriptor),
      playerEngineVersion,
      playerBuildId,
    };
    const externalCatalog = JSON.parse(
      readFileSync(resolve(externalOutput, "catalog.json"), "utf8"),
    );
    const labCatalog = JSON.parse(readFileSync(resolve(labOutput, "catalog.json"), "utf8"));
    labCatalog.examples[0].source.path = "tests/projects/feature-lab";
    aggregateQualifiedExamples({
      output,
      ntRevision,
      producers: [
        {
          catalog: externalCatalog,
          outputRoot: externalOutput,
          expected: { ...expected, revision },
        },
        {
          catalog: labCatalog,
          outputRoot: labOutput,
          expected: {
            ...expected,
            revision: ntRevision,
            repository: "https://github.com/Cruel/nt",
            requiredIds: ["feature-lab"],
          },
        },
      ],
    });
    return { revision, catalogPath: resolve(output, "catalog.json") };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
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
