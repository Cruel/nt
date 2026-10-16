// The schema generator and the native/Zod differential test share the exact
// TypeScript source loader; neither requires a separately compiled editor.
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return next(specifier + suffix, context);
        } catch (candidate) {
          if (candidate.code !== 'ERR_MODULE_NOT_FOUND') throw candidate;
        }
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('.json'))
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${readFileSync(fileURLToPath(url), 'utf8')};`,
      };
    if (url.endsWith('.ts'))
      return {
        format: 'module',
        shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), {
          mode: 'transform',
          sourceUrl: url,
        }),
      };
    return next(url, context);
  },
});
