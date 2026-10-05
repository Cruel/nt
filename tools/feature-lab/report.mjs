import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_LAB_MANIFEST_RELATIVE_PATH, validateFeatureLabManifest } from './validate.mjs';

export async function generateFeatureLabAccounting(catalog, options) {
  const { errors, derived } = await validateFeatureLabManifest(catalog, options);
  if (errors.length) throw new Error(errors.map((item) => `${item.code} ${item.path}: ${item.message}`).join('\n'));
  const checks = catalog.scenarios.flatMap((scenario) => scenario.checks.map((check) => ({
    id: `${scenario.id}/${check.id}`,
    scenarioStatus: scenario.status,
    status: check.status,
    statusReason: check.statusReason ?? null,
    verification: check.verification,
    expected: check.expected,
    automation: check.automation,
    assetRequirements: check.assetRequirements,
  })));
  const testRoot = path.join(options.projectRoot, 'records', 'tests');
  const tests = [];
  for (const filename of (await readdir(testRoot)).filter((name) => name.endsWith('.json')).sort()) {
    const record = JSON.parse(await readFile(path.join(testRoot, filename), 'utf8'));
    if (record.id !== filename.slice(0, -5) || record.data?.kind !== 'test' || !Array.isArray(record.data.steps))
      throw new Error(`Invalid authored Test record '${filename}'.`);
    tests.push({
      id: record.id,
      steps: record.data.steps.length,
      checks: checks.filter((check) => check.automation.some((target) => target.kind !== 'visual-checkpoint' && target.id === record.id)).map((check) => check.id),
    });
  }
  return {
    summary: {
      scenarios: catalog.scenarios.length,
      checks: checks.length,
      checkStatuses: Object.fromEntries(['ready', 'provisional', 'blocked'].map((status) => [status, checks.filter((check) => check.status === status).length])),
      checksWithAutomation: checks.filter((check) => check.automation.length > 0).length,
      authoredTests: tests.length,
      unlinkedTests: tests.filter((entry) => entry.checks.length === 0).length,
      visualCheckpoints: catalog.visualCheckpoints.length,
      automationOnly: catalog.automationOnly.length,
      deferred: catalog.deferredCoverage.length,
    },
    scenarios: catalog.scenarios.map((scenario) => ({
      id: scenario.id,
      status: scenario.status,
      statusReason: scenario.statusReason ?? null,
      ...derived.scenarios[scenario.id],
    })),
    checks,
    tests,
    visualCheckpoints: catalog.visualCheckpoints,
    assetRequirements: catalog.assetRequirements,
    automationOnly: catalog.automationOnly,
    deferredCoverage: catalog.deferredCoverage,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--project');
  const outputIndex = args.indexOf('--output');
  const projectRoot = path.resolve(rootIndex >= 0 ? args[rootIndex + 1] : 'tests/projects/feature-lab');
  const catalog = JSON.parse(await readFile(path.join(projectRoot, FEATURE_LAB_MANIFEST_RELATIVE_PATH), 'utf8'));
  const report = await generateFeatureLabAccounting(catalog, { projectRoot });
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  if (outputIndex >= 0) {
    const output = path.resolve(args[outputIndex + 1]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
  } else {
    process.stdout.write(bytes);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
