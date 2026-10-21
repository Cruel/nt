import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Plugin } from 'vite/rolldown';

/** Build-only proof for #521's strict emitted Project-authority closure gate. */
export function nativeProductionProvenance(editorRoot: string): Plugin {
  const normalizedRoot = path.resolve(editorRoot).replaceAll('\\', '/');
  const normalizedRepositoryRoot = path.resolve(editorRoot, '..').replaceAll('\\', '/');
  return {
    name: 'noveltea-native-production-provenance',
    generateBundle(_options, bundle) {
      const chunks: Record<string, { sha256: string; modules: string[] }> = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        chunks[output.fileName] = {
          sha256: createHash('sha256').update(output.code).digest('hex'),
          modules: Object.keys(output.modules)
            .map((id) => {
              const normalized = id.replaceAll('\\', '/');
              if (normalized.startsWith(`${normalizedRoot}/`))
                return normalized.slice(normalizedRoot.length + 1);
              if (normalized.startsWith(`${normalizedRepositoryRoot}/`))
                return `../${normalized.slice(normalizedRepositoryRoot.length + 1)}`;
              // Do not embed a developer's checkout or toolchain paths in
              // distributed manifests; only in-repository modules can own
              // retired NovelTea Project authority.
              return path.isAbsolute(normalized)
                ? `@external/${path.basename(normalized)}`
                : normalized;
            })
            .sort(),
        };
      }
      this.emitFile({
        type: 'asset',
        fileName: 'native-production-provenance.json',
        source: `${JSON.stringify({ version: 1, chunks })}\n`,
      });
    },
  };
}
