#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const RESULTS_FORMAT = 'noveltea-platform-certification-results';
const PROOF_FORMAT = 'noveltea-platform-certification-proof';
const contract = JSON.parse(
  await readFile(
    new URL('../editor/src/shared/project-schema/platform-certification-contract.json', import.meta.url),
    'utf8',
  ),
);
function parseArgs(argv) {
  const options = { smokes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument '${key}'.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value.`);
    if (key === '--smoke') options.smokes.push(value);
    else options[key.slice(2).replaceAll('-', '_')] = value;
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (!value) throw new Error(`Missing required option --${name.replaceAll('_', '-')}.`);
  return path.resolve(value);
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fileSha256 = async (file) => sha256(await readFile(file));

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}.`)),
    );
  });
}

async function walk(root, prefix = '') {
  const output = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Archive contains forbidden link '${relative}'.`);
    if (entry.isDirectory()) output.push(...(await walk(root, relative)));
    else if (entry.isFile()) output.push(relative);
    else throw new Error(`Archive contains non-regular entry '${relative}'.`);
  }
  return output.sort((left, right) => left.localeCompare(right));
}

function safeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

async function extractArchive(archive) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'noveltea-cert-results-'));
  await run('cmake', ['-E', 'tar', 'xf', archive], { cwd: temp });
  const archiveFiles = await walk(temp);
  const descriptorPaths = archiveFiles.filter((file) => path.posix.basename(file) === 'template.json');
  if (descriptorPaths.length !== 1)
    throw new Error(`Template archive must contain exactly one template.json; found ${descriptorPaths.length}.`);
  const descriptorPath = descriptorPaths[0];
  const templateRootRelative = path.posix.dirname(descriptorPath);
  const templateRoot =
    templateRootRelative === '.' ? temp : path.join(temp, ...templateRootRelative.split('/'));
  const descriptor = JSON.parse(await readFile(path.join(templateRoot, 'template.json'), 'utf8'));
  return { temp, templateRoot, descriptor };
}

function requiredChecks(descriptor) {
  const checks = [...contract.universalChecks, ...(contract.targetChecks[descriptor.platform] ?? [])];
  if (descriptor.platform === 'android') {
    const artifactKinds = descriptor.android?.artifactKinds ?? [];
    for (const conditional of contract.conditionalChecks ?? []) {
      if (
        conditional.platform === 'android' &&
        artifactKinds.includes(conditional.artifactKind)
      )
        checks.push(conditional.check);
    }
  }
  return [...new Set(checks)];
}

function environmentFor(target) {
  return {
    workflow: process.env.GITHUB_WORKFLOW ?? 'local-release-certification',
    runId: process.env.GITHUB_RUN_ID ?? 'local',
    job: process.env.GITHUB_JOB ?? `local-${target}`,
    runnerOs: process.env.RUNNER_OS ?? process.platform,
    runnerArch: process.env.RUNNER_ARCH ?? process.arch,
    target,
  };
}

async function verifyTemplateArchive(archive, templateRoot, descriptor) {
  if (descriptor.format !== 'noveltea.player-template' || descriptor.formatVersion !== 1)
    throw new Error('Template descriptor format is invalid.');
  if (!contract.targetChecks[descriptor.platform])
    throw new Error(`Unsupported template platform '${descriptor.platform}'.`);
  if (path.basename(archive) !== descriptor.artifacts?.archive)
    throw new Error(
      `Template archive name '${path.basename(archive)}' does not match descriptor '${descriptor.artifacts?.archive}'.`,
    );
  const declared = [...(descriptor.files ?? [])].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const declaredNames = new Set();
  for (const item of declared) {
    if (!safeRelativePath(item.path)) throw new Error(`Unsafe descriptor path '${item.path}'.`);
    if (declaredNames.has(item.path)) throw new Error(`Duplicate descriptor path '${item.path}'.`);
    declaredNames.add(item.path);
    const file = path.join(templateRoot, ...item.path.split('/'));
    const data = await readFile(file);
    const info = await stat(file);
    if (data.length !== item.size)
      throw new Error(`Descriptor size mismatch for '${item.path}'.`);
    if (sha256(data) !== item.sha256)
      throw new Error(`Descriptor SHA-256 mismatch for '${item.path}'.`);
    if (!info.isFile()) throw new Error(`Descriptor entry '${item.path}' is not a regular file.`);
  }
  const actual = (await walk(templateRoot)).filter((file) => file !== 'template.json');
  if (
    actual.length !== declared.length ||
    actual.some((file, index) => file !== declared[index]?.path)
  )
    throw new Error('Template archive inventory does not exactly match descriptor.files.');
  for (const dependency of descriptor.runtimeDependencies ?? []) {
    if (!declaredNames.has(dependency.path))
      throw new Error(`Runtime dependency '${dependency.path}' is absent from descriptor.files.`);
  }
  return { declaredCount: declared.length, runtimeDependencyCount: descriptor.runtimeDependencies?.length ?? 0 };
}

async function verifySymbols(archive, descriptor) {
  const symbols = path.join(path.dirname(archive), descriptor.artifacts.symbols);
  const info = await stat(symbols);
  if (!info.isFile() || info.size === 0) throw new Error('Symbol archive is missing or empty.');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'noveltea-symbol-cert-'));
  try {
    await run('cmake', ['-E', 'tar', 'xf', symbols], { cwd: temp });
    const files = await walk(temp);
    const buildIdFiles = files.filter((file) => path.posix.basename(file) === 'BUILD_ID');
    if (buildIdFiles.length !== 1)
      throw new Error(`Symbol archive must contain exactly one BUILD_ID; found ${buildIdFiles.length}.`);
    const buildId = (await readFile(path.join(temp, ...buildIdFiles[0].split('/')), 'utf8')).trim();
    if (buildId !== descriptor.buildId)
      throw new Error(`Symbol BUILD_ID '${buildId}' does not match template '${descriptor.buildId}'.`);
    if (files.length < 2) throw new Error('Symbol archive contains no build symbols.');
    return { path: symbols, buildId, fileCount: files.length };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function verifyNoticeAndSbom(templateRoot, descriptor) {
  for (const [label, relative] of [
    ['notices', descriptor.artifacts.notices],
    ['SBOM', descriptor.artifacts.sbom],
  ]) {
    if (!safeRelativePath(relative)) throw new Error(`Invalid ${label} path '${relative}'.`);
    const data = await readFile(path.join(templateRoot, ...relative.split('/')));
    if (data.length === 0) throw new Error(`${label} artifact is empty.`);
  }
  const sbom = JSON.parse(
    await readFile(path.join(templateRoot, ...descriptor.artifacts.sbom.split('/')), 'utf8'),
  );
  if (sbom.bomFormat !== 'CycloneDX') throw new Error('Template SBOM is not CycloneDX.');
  return { sbomFormat: sbom.bomFormat };
}

async function readJson(file, expectedFormat) {
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (expectedFormat && value.format !== expectedFormat)
    throw new Error(`${file} has format '${value.format}', expected '${expectedFormat}'.`);
  return value;
}

function verifyCanonicalEvidence(canonical, descriptor, label = 'Canonical evidence') {
  if (process.env.GITHUB_SHA && canonical.sourceRevision !== process.env.GITHUB_SHA)
    throw new Error(
      `${label} source revision '${canonical.sourceRevision}' does not match '${process.env.GITHUB_SHA}'.`,
    );
  if (canonical.target !== descriptor.platform)
    throw new Error(`${label} target '${canonical.target}' does not match '${descriptor.platform}'.`);
  if (canonical.architecture !== descriptor.architecture)
    throw new Error(
      `${label} architecture '${canonical.architecture}' does not match '${descriptor.architecture}'.`,
    );
  if (canonical.buildFlavor !== descriptor.buildFlavor)
    throw new Error(`${label} build flavor does not match template descriptor.`);
  if (canonical.templateId !== descriptor.templateId || canonical.templateBuildId !== descriptor.buildId)
    throw new Error(`${label} does not identify the certified template build.`);
  for (const [field, description] of [
    ['runtimePackageSha256', 'runtime package'],
    ['profileSha256', 'profile'],
    ['projectSha256', 'project'],
    ['outputManifestSha256', 'output manifest'],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(canonical[field] ?? ''))
      throw new Error(`${label} is missing a ${description} SHA-256.`);
  }
  for (const field of ['compiledProjectFormatVersion', 'playerRuntimeApiVersion']) {
    if (!Number.isInteger(canonical[field]) || canonical[field] < 0)
      throw new Error(`${label} is missing a valid ${field}.`);
  }
  if (typeof canonical.packageAccessMode !== 'string' || canonical.packageAccessMode.length === 0)
    throw new Error(`${label} is missing its exercised package access mode.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const archive = requireOption(options, 'archive');
  const canonicalEvidencePath = requireOption(options, 'canonical_evidence');
  const output = requireOption(options, 'output');
  const { temp, templateRoot, descriptor } = await extractArchive(archive);
  const environment = environmentFor(descriptor.platform);
  const proofsRoot = path.dirname(output);
  const evidence = [];
  const seen = new Set();

  const addProof = async ({ check, detail, verifier, sources = [] }) => {
    if (seen.has(check)) throw new Error(`Duplicate produced certification check '${check}'.`);
    seen.add(check);
    const sourceEvidence = [];
    for (const source of sources) {
      const resolved = path.resolve(source);
      sourceEvidence.push({ name: path.basename(resolved), sha256: await fileSha256(resolved) });
    }
    const proofPath = path.join(
      proofsRoot,
      `noveltea-certification-evidence-${descriptor.templateId}-${check}.json`,
    );
    await mkdir(path.dirname(proofPath), { recursive: true });
    const proof = {
      format: PROOF_FORMAT,
      check,
      target: descriptor.platform,
      templateId: descriptor.templateId,
      buildId: descriptor.buildId,
      detail,
      verifier,
      sources: sourceEvidence,
    };
    await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
    evidence.push({
      check,
      status: 'passed',
      detail,
      test: verifier,
      target: descriptor.platform,
      artifact: path.basename(proofPath),
      producer: 'scripts/platform-certification-results.mjs',
      command: `node scripts/platform-certification-results.mjs --check ${check}`,
      environment,
    });
  };

  try {
    const archiveAudit = await verifyTemplateArchive(archive, templateRoot, descriptor);
    await addProof({
      check: 'artifact-claims',
      detail: `Template archive identity and declared release artifacts match ${descriptor.templateId}@${descriptor.buildId}.`,
      verifier: 'platform-certification-results#verifyTemplateArchive',
      sources: [archive],
    });
    await addProof({
      check: 'descriptor-file-integrity',
      detail: `Verified ${archiveAudit.declaredCount} descriptor file records against archive bytes.`,
      verifier: 'platform-certification-results#verifyTemplateArchive',
      sources: [archive],
    });
    await addProof({
      check: 'runtime-closure',
      detail: `Verified ${archiveAudit.runtimeDependencyCount} declared runtime dependencies are present in the immutable template inventory.`,
      verifier: 'platform-certification-results#verifyTemplateArchive',
      sources: [archive],
    });

    const symbols = await verifySymbols(archive, descriptor);
    await addProof({
      check: 'symbols-build-id',
      detail: `Symbol archive contains build-matched BUILD_ID ${symbols.buildId}.`,
      verifier: 'platform-certification-results#verifySymbols',
      sources: [symbols.path],
    });

    const metadata = await verifyNoticeAndSbom(templateRoot, descriptor);
    await addProof({
      check: 'third-party-notices',
      detail: 'Template contains the declared non-empty third-party notices artifact.',
      verifier: 'platform-certification-results#verifyNoticeAndSbom',
      sources: [archive],
    });
    await addProof({
      check: 'sbom',
      detail: `Template contains a parseable ${metadata.sbomFormat} SBOM at the declared path.`,
      verifier: 'platform-certification-results#verifyNoticeAndSbom',
      sources: [archive],
    });

    const canonical = await readJson(
      canonicalEvidencePath,
      'noveltea-canonical-export-fixture',
    );
    verifyCanonicalEvidence(canonical, descriptor);
    await addProof({
      check: 'template-install-integrity',
      detail: 'Canonical export test installed and verified the exact template before export.',
      verifier:
        'editor/src/renderer/test/platform-export-canonical-integration.test.ts > materializes the canonical authoring fixture and exports it through the headless project/profile workflow',
      sources: [canonicalEvidencePath],
    });
    await addProof({
      check: 'canonical-export',
      detail: 'Canonical project/profile export completed through the public project/profile workflow.',
      verifier:
        'editor/src/renderer/test/platform-export-canonical-integration.test.ts > materializes the canonical authoring fixture and exports it through the headless project/profile workflow',
      sources: [canonicalEvidencePath],
    });
    await addProof({
      check: 'runtime-package-integrity',
      detail: `Canonical export bound runtime package SHA-256 ${canonical.runtimePackageSha256} to its output manifest.`,
      verifier:
        'editor/src/renderer/test/platform-export-canonical-integration.test.ts > runtime package evidence assertions',
      sources: [canonicalEvidencePath],
    });

    for (const smokePathValue of options.smokes) {
      const smokePath = path.resolve(smokePathValue);
      const smoke = await readJson(smokePath, 'noveltea-platform-native-smoke');
      if (smoke.target !== descriptor.platform || smoke.status !== 'passed')
        throw new Error(`Native smoke evidence '${smokePath}' is not a passing ${descriptor.platform} result.`);
      for (const check of smoke.checks ?? []) {
        await addProof({
          check,
          detail: smoke.detail ?? `${check} passed in the finalized native export smoke.`,
          verifier: smoke.test ?? 'platform-staging-service native release smoke',
          sources: [smokePath],
        });
      }
    }

    if (options.dependency_audit) {
      const auditPath = path.resolve(options.dependency_audit);
      const audit = await readJson(auditPath, 'noveltea-player-dependency-audit');
      if (audit.platform !== descriptor.platform || audit.status !== 'passed')
        throw new Error('Dependency audit evidence does not match the certified platform.');
      for (const check of audit.checks ?? []) {
        await addProof({
          check,
          detail: audit.detail ?? `${check} passed for the packaged player dependency closure.`,
          verifier: 'cmake/AuditNovelTeaPlayerDependencies.cmake',
          sources: [auditPath],
        });
      }
    }

    if (descriptor.platform === 'web') {
      const browserPath = requireOption(options, 'web_browser');
      const nestedCanonicalPath = requireOption(options, 'nested_canonical_evidence');
      const casePrefix = options.web_case_prefix;
      if (!casePrefix) throw new Error('Web certification requires --web-case-prefix.');
      const nestedCanonical = await readJson(
        nestedCanonicalPath,
        'noveltea-canonical-export-fixture',
      );
      verifyCanonicalEvidence(nestedCanonical, descriptor, 'Nested canonical evidence');
      const expectedThreaded = descriptor.compiledFeatures.includes('web-threads');
      const expectedSingleThreaded = descriptor.compiledFeatures.includes('web-single-threaded');
      if (expectedThreaded === expectedSingleThreaded)
        throw new Error('Web template must declare exactly one threading feature.');
      if (
        canonical.webBasePath !== '/' ||
        nestedCanonical.webBasePath !== '/nested/game/' ||
        canonical.webThreaded !== expectedThreaded ||
        nestedCanonical.webThreaded !== expectedThreaded
      )
        throw new Error('Canonical Web evidence does not match the certified base-path/threading variant.');
      const browser = await readJson(browserPath, 'noveltea.web-export-browser-certification');
      const rootCase = browser.results?.find((item) => item.label === `${casePrefix}-root`);
      const nestedCase = browser.results?.find((item) => item.label === `${casePrefix}-nested`);
      if (!rootCase || rootCase.basePath !== '/' || !rootCase.launchGestureGated)
        throw new Error(`Browser evidence is missing passing '${casePrefix}-root'.`);
      if (!nestedCase || nestedCase.basePath !== '/nested/game/' || !nestedCase.launchGestureGated)
        throw new Error(`Browser evidence is missing passing '${casePrefix}-nested'.`);
      if (rootCase.packageSha256 !== canonical.runtimePackageSha256)
        throw new Error('Root browser package hash does not match root canonical export evidence.');
      if (nestedCase.packageSha256 !== nestedCanonical.runtimePackageSha256)
        throw new Error('Nested browser package hash does not match nested canonical export evidence.');
      await addProof({
        check: 'web-browser-launch',
        detail: `Chromium reached the player-ready marker for ${casePrefix} root and nested deployments.`,
        verifier: 'scripts/web-export-certification.mjs',
        sources: [browserPath, canonicalEvidencePath, nestedCanonicalPath],
      });
      await addProof({
        check: 'web-root-path',
        detail: `Chromium loaded the canonical ${casePrefix} export from '/'.`,
        verifier: 'scripts/web-export-certification.mjs',
        sources: [browserPath, canonicalEvidencePath],
      });
      await addProof({
        check: 'web-subdirectory-path',
        detail: `Chromium loaded the canonical ${casePrefix} export from '/nested/game/'.`,
        verifier: 'scripts/web-export-certification.mjs',
        sources: [browserPath, nestedCanonicalPath],
      });
    }

    if (descriptor.platform === 'android') {
      const reportPath = requireOption(options, 'android_report');
      const alignmentPath = requireOption(options, 'android_alignment');
      const report = await readJson(reportPath, 'noveltea.android-export-report');
      if (report.template?.id !== descriptor.templateId || report.template?.buildId !== descriptor.buildId)
        throw new Error('Android export report does not identify the certified template build.');
      if (report.verification?.status !== 'passed')
        throw new Error('Android artifact inspection report did not pass.');
      if (!/^[0-9a-f]{64}$/.test(report.package?.sha256 ?? ''))
        throw new Error('Android public-CLI export report is missing its verified package SHA-256.');
      const inspected = report.verification?.inspected ?? [];
      if (inspected.length === 0) throw new Error('Android report contains no inspected artifacts.');
      const expectedAbi = descriptor.android?.supportedAbis?.[0];
      if (report.verification?.abi !== expectedAbi)
        throw new Error(`Android report ABI '${report.verification?.abi}' does not match '${expectedAbi}'.`);
      const alignment = await readJson(alignmentPath, 'noveltea-android-load-alignment');
      const alignmentResult = alignment.results?.find((item) => item.abi === expectedAbi);
      if (!alignmentResult || alignmentResult.status !== 'passed')
        throw new Error(`Android native LOAD alignment evidence is missing for '${expectedAbi}'.`);
      await addProof({
        check: 'android-artifact-inspection',
        detail: 'Final Android APK/AAB artifact inspection completed without diagnostics.',
        verifier: 'editor/src/main/services/android-artifact-inspection-service.ts',
        sources: [reportPath],
      });
      await addProof({
        check: 'android-abi-closure',
        detail: `Final Android artifacts contain exactly the declared '${expectedAbi}' native closure.`,
        verifier: 'editor/src/main/services/android-artifact-inspection-service.ts',
        sources: [reportPath],
      });
      await addProof({
        check: 'android-signature-policy',
        detail: `Android ${descriptor.buildFlavor} signature policy passed for every inspected artifact.`,
        verifier: 'editor/src/main/services/android-artifact-inspection-service.ts',
        sources: [reportPath],
      });
      await addProof({
        check: 'android-page-alignment',
        detail: `APK ZIP alignment and native ${expectedAbi} PT_LOAD alignment both satisfy the 16 KiB release contract.`,
        verifier:
          'android-artifact-inspection-service + scripts/verify-android-load-alignment.mjs',
        sources: [reportPath, alignmentPath],
      });
      if ((descriptor.android?.artifactKinds ?? []).includes('aab')) {
        const aab = inspected.find((item) => item.kind === 'aab');
        if (!aab || aab.bundletool !== 'passed')
          throw new Error('Android AAB bundletool verification did not pass.');
        await addProof({
          check: 'android-bundletool',
          detail: 'AAB produced a verified universal APK set through the pinned bundletool.',
          verifier: 'editor/src/main/services/android-artifact-inspection-service.ts',
          sources: [reportPath],
        });
      }
    }

    const required = requiredChecks(descriptor);
    const missing = required.filter((check) => !seen.has(check));
    const unexpected = [...seen].filter((check) => !required.includes(check));
    if (missing.length)
      throw new Error(`Certification producer is missing required checks: ${missing.join(', ')}.`);
    if (unexpected.length)
      throw new Error(`Certification producer emitted out-of-scope checks: ${unexpected.join(', ')}.`);

    const results = {
      format: RESULTS_FORMAT,
      fixtureRevision: canonical.fixtureRevision,
      runtimePackageSha256: canonical.runtimePackageSha256,
      profileSha256: canonical.profileSha256,
      environment,
      exercised: {
        compiledProjectFormatVersions: [canonical.compiledProjectFormatVersion],
        playerRuntimeApiVersions: [canonical.playerRuntimeApiVersion],
        packageAccessModes: [canonical.packageAccessMode],
      },
      evidence,
      hostGaps: [],
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(results, null, 2)}\n`);
    process.stdout.write(
      `Produced ${evidence.length} explicit certification checks for ${descriptor.templateId}.\n`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
