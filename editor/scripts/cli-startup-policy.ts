import { isBuiltin } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite/rolldown';

export function cliStartupPolicy(label: string, entry: string, maxBytes = 64 * 1024): Plugin {
  const entryId = path.resolve(entry).replaceAll('\\', '/');
  return {
    name: 'noveltea-cli-startup-policy',
    generateBundle(_options, bundle) {
      const entryChunk = Object.values(bundle).find(
        (output) =>
          output.type === 'chunk' &&
          output.isEntry &&
          output.facadeModuleId?.replaceAll('\\', '/') === entryId,
      );
      if (!entryChunk || entryChunk.type !== 'chunk')
        throw new Error(`${label} startup entry was not emitted: ${entry}`);

      const pending = [entryChunk.fileName];
      const visited = new Set<string>();
      let bytes = 0;
      while (pending.length > 0) {
        const fileName = pending.pop()!;
        if (visited.has(fileName)) continue;
        visited.add(fileName);
        const chunk = bundle[fileName];
        if (!chunk || chunk.type !== 'chunk')
          throw new Error(`${label} startup import is not an emitted chunk: ${fileName}`);
        bytes += Buffer.byteLength(chunk.code);
        const forbidden = Object.keys(chunk.modules).filter((id) =>
          /(project-workspace|semantic-project|platform-(?:tool|host|staging|export)|sharp|native-tool-service|authoring-)/u.test(
            id,
          ),
        );
        if (forbidden.length > 0)
          throw new Error(
            `${label} static startup closure eagerly includes heavy modules: ${forbidden.join(', ')}`,
          );

        // Bundler metadata includes static re-exports but keeps dynamic imports separate.
        for (const dependency of chunk.imports) {
          if (bundle[dependency]) pending.push(dependency);
          else if (!isBuiltin(dependency))
            throw new Error(
              `${label} static startup closure eagerly imports external dependency: ${dependency}`,
            );
        }
      }
      if (bytes > maxBytes)
        throw new Error(
          `${label} static startup closure grew to ${bytes} bytes across ${visited.size} modules; expected at most ${maxBytes} bytes. Modules: ${[...visited].sort().join(', ')}`,
        );
    },
  };
}
