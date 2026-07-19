import { promises as fs } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const editorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(editorRoot, '..');
const outputRoot = path.join(editorRoot, 'dist-electron');
const nodeBuiltins = new Set(builtinModules.map((moduleName) => moduleName.replace(/^node:/, '')));

const requiredOutputs = {
  main: path.join(outputRoot, 'main', 'main.cjs'),
  preload: path.join(outputRoot, 'preload', 'preload.cjs'),
  compiler: path.join(outputRoot, 'tools', 'project-compile.mjs'),
  goldens: path.join(outputRoot, 'tools', 'generate-compiled-project-goldens.mjs'),
};

function fail(message) {
  throw new Error(`Bundle policy violation: ${message}`);
}

async function readRequiredFile(label, filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    fail(`${label} output is missing at ${path.relative(editorRoot, filePath)} (${error.message})`);
  }
}

async function listFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function assertOnlyDeclaredFiles(directory, allowedRelativePaths) {
  return listFiles(directory).then((files) => {
    for (const filePath of files) {
      const relative = path.relative(directory, filePath).split(path.sep).join('/');
      if (!allowedRelativePaths.has(relative)) fail(`undeclared output chunk: ${relative}`);
    }
  });
}

function assertNoCheckoutPaths(label, text) {
  for (const checkoutPath of [repositoryRoot, editorRoot]) {
    const normalized = checkoutPath.split(path.sep).join('/');
    if (text.includes(checkoutPath) || text.includes(normalized)) {
      fail(`${label} embeds the source checkout path ${checkoutPath}`);
    }
  }
}

function assertNoForbiddenRuntimeImport(label, text) {
  const forbiddenImport =
    /(?:from\s*|require\s*\(|import\s*\()\s*['"](?:electron|vite-plus(?:\/[^'"]*)?|vitest(?:\/[^'"]*)?|vite-node|tsx|@electron-forge\/[^'"]+)['"]/;
  if (forbiddenImport.test(text)) fail(`${label} imports Electron or a development-only package`);
}

function packageNameForSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function assertRuntimeImports(label, text, allowedPackages, format) {
  const patterns =
    format === 'cjs'
      ? [/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]
      : [
          /^\s*import(?:\s+[^'"\n]+?\s+from)?\s*['"]([^'"]+)['"];?\s*$/gm,
          /^\s*export\s+[^'"\n]+?\s+from\s*['"]([^'"]+)['"];?\s*$/gm,
        ];
  const specifiers = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  }

  for (const specifier of specifiers) {
    if (
      specifier.startsWith('.') ||
      specifier.startsWith('/') ||
      specifier.startsWith('file:') ||
      specifier.startsWith('data:')
    ) {
      continue;
    }
    const normalized = specifier.replace(/^node:/, '');
    if (nodeBuiltins.has(normalized) || nodeBuiltins.has(normalized.split('/')[0])) continue;
    const packageName = packageNameForSpecifier(specifier);
    if (allowedPackages.has(packageName)) continue;
    fail(`${label} has undeclared external runtime import '${specifier}'`);
  }
}

const mainText = await readRequiredFile('main', requiredOutputs.main);
const preloadText = await readRequiredFile('preload', requiredOutputs.preload);
const compilerText = await readRequiredFile('project compiler', requiredOutputs.compiler);
const goldensText = await readRequiredFile('golden generator', requiredOutputs.goldens);

if (!/require\(["']electron["']\)/.test(mainText)) {
  fail('main output does not preserve Electron as an external runtime module');
}
if (!/require\(["']sharp["']\)/.test(mainText)) {
  fail('main output does not preserve sharp as an external runtime package');
}
if (
  /(?:node_modules[\\/]sharp|sharp[\\/](?:dist|lib)[\\/]|@img[\\/]sharp|sharp\.node|libvips)/i.test(
    mainText,
  )
) {
  fail('sharp or its native loader was bundled into the main output');
}
if (/\bimport\.meta\.url\b|\bimport_meta\d*\.url\b/.test(mainText)) {
  fail('main output contains a transformed import.meta.url expression');
}
if (!/require\(["']electron["']\)/.test(preloadText)) {
  fail('preload output does not preserve Electron as an external runtime module');
}

assertRuntimeImports('main', mainText, new Set(['electron', 'sharp']), 'cjs');
assertRuntimeImports('preload', preloadText, new Set(['electron']), 'cjs');

await assertOnlyDeclaredFiles(path.join(outputRoot, 'main'), new Set(['main.cjs', 'main.cjs.map']));
await assertOnlyDeclaredFiles(
  path.join(outputRoot, 'preload'),
  new Set(['preload.cjs', 'preload.cjs.map']),
);

for (const [label, text] of Object.entries({
  main: mainText,
  preload: preloadText,
  compiler: compilerText,
  goldens: goldensText,
})) {
  assertNoCheckoutPaths(label, text);
}
assertNoForbiddenRuntimeImport('project compiler', compilerText);
assertNoForbiddenRuntimeImport('golden generator', goldensText);

const toolFiles = (await listFiles(path.join(outputRoot, 'tools'))).filter((filePath) =>
  filePath.endsWith('.mjs'),
);
for (const toolFile of toolFiles) {
  const text = await fs.readFile(toolFile, 'utf8');
  const label = path.relative(editorRoot, toolFile);
  assertNoForbiddenRuntimeImport(label, text);
  assertRuntimeImports(label, text, new Set(), 'esm');
}

const generatedFiles = await listFiles(outputRoot);
for (const generatedFile of generatedFiles) {
  if (!/\.(?:cjs|mjs|js|map)$/.test(generatedFile)) continue;
  const text = await fs.readFile(generatedFile, 'utf8');
  assertNoCheckoutPaths(path.relative(editorRoot, generatedFile), text);
}

process.stdout.write('Bundle policy validation passed.\n');
