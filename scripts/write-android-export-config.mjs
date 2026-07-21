#!/usr/bin/env node

import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function usage() {
  return 'Usage: pnpm android:export-config -- --output <file>\n';
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

function requiredEnvironment(names, label) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  throw new Error(`${label} is not configured. Set ${names.join(' or ')}.`);
}

async function requirePath(filePath, label) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (args.includes('--help')) {
    process.stdout.write(usage());
    return;
  }

  const output = optionValue(args, '--output');
  if (!output) throw new Error(`Missing required option --output.\n${usage()}`);
  const unknown = args.filter(
    (argument, index) =>
      argument.startsWith('--') &&
      argument !== '--output' &&
      argument !== '--help' &&
      args[index - 1] !== '--output',
  );
  if (unknown.length) throw new Error(`Unknown option '${unknown[0]}'.\n${usage()}`);

  const androidSdk = requiredEnvironment(['ANDROID_SDK_ROOT', 'ANDROID_HOME'], 'Android SDK');
  const javaHome = requiredEnvironment(['JAVA_HOME'], 'Java home');
  const shaderc = requiredEnvironment(['SHADERC', 'NOVELTEA_SHADERC'], 'shaderc');
  const bgfxShaderIncludeDir = requiredEnvironment(
    ['BGFX_SHADER_INCLUDE_DIR', 'BGFX_SHADER_INCLUDE', 'NOVELTEA_BGFX_SHADER_INCLUDE_DIR'],
    'bgfx shader include directory',
  );

  await Promise.all([
    requirePath(androidSdk, 'Android SDK'),
    requirePath(javaHome, 'Java home'),
    requirePath(shaderc, 'shaderc'),
    requirePath(path.join(bgfxShaderIncludeDir, 'bgfx_shader.sh'), 'bgfx_shader.sh'),
  ]);

  const outputPath = path.resolve(output);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ androidSdk, javaHome, shaderc, bgfxShaderIncludeDir })}\n`,
      'utf8',
    );
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  process.stdout.write(`${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
