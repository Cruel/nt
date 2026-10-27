// Build-host only: resolve the editor's extensionless TypeScript imports under
// Node's type-stripping loader. The generated native CLI never executes JS.
import { readFileSync } from 'node:fs';

export async function load(url, context, nextLoad) {
  if (url.endsWith('/src/shared/product-version.ts')) {
    const version = readFileSync(new URL('../../../VERSION', url), 'utf8').trim();
    return {
      format: 'module',
      shortCircuit: true,
      source: `export const NOVELTEA_VERSION = ${JSON.stringify(version)}; export const NOVELTEA_BUILD_IDENTITY = 'native-agent-kit-build';`,
    };
  }
  if (url.endsWith('.json'))
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(JSON.parse(readFileSync(new URL(url), 'utf8')))};`,
    };
  return nextLoad(url, context);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      error?.code !== 'ERR_MODULE_NOT_FOUND' ||
      !(specifier.startsWith('.') || specifier.startsWith('/'))
    )
      throw error;
    for (const suffix of ['.ts', '/index.ts']) {
      try {
        return await nextResolve(specifier + suffix, context);
      } catch (candidateError) {
        if (candidateError?.code !== 'ERR_MODULE_NOT_FOUND') throw candidateError;
      }
    }
    throw error;
  }
}
