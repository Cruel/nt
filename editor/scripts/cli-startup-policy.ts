import { isBuiltin } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite/rolldown';

function cliStaticClosurePolicy(
  label: string,
  modulePath: string,
  maxBytes: number,
  options: Readonly<{ entry: boolean; forbidHeavySources: boolean }>,
): Plugin {
  const moduleId = path.resolve(modulePath).replaceAll('\\', '/');
  const scope = options.entry ? 'startup' : 'lazy-module';
  return {
    name: `noveltea-cli-${scope}-policy`,
    generateBundle(_options, bundle) {
      const rootChunk = Object.values(bundle).find(
        (output) =>
          output.type === 'chunk' &&
          (!options.entry || output.isEntry) &&
          output.facadeModuleId?.replaceAll('\\', '/') === moduleId,
      );
      if (!rootChunk || rootChunk.type !== 'chunk')
        throw new Error(`${label} ${scope} root was not emitted: ${modulePath}`);

      const pending = [rootChunk.fileName];
      const visited = new Set<string>();
      let bytes = 0;
      while (pending.length > 0) {
        const fileName = pending.pop()!;
        if (visited.has(fileName)) continue;
        visited.add(fileName);
        const chunk = bundle[fileName];
        if (!chunk || chunk.type !== 'chunk')
          throw new Error(`${label} ${scope} import is not an emitted chunk: ${fileName}`);
        bytes += Buffer.byteLength(chunk.code);
        if (options.forbidHeavySources) {
          const forbidden = Object.keys(chunk.modules).filter((id) =>
            /(project-workspace|semantic-project|platform-(?:tool|host|staging|export)|sharp|native-tool-service|authoring-)/u.test(
              id,
            ),
          );
          if (forbidden.length > 0)
            throw new Error(
              `${label} static startup closure eagerly includes heavy modules: ${forbidden.join(', ')}`,
            );
        }

        // Bundler metadata includes static re-exports but keeps dynamic imports separate.
        for (const dependency of chunk.imports) {
          if (bundle[dependency]) pending.push(dependency);
          else if (!isBuiltin(dependency))
            throw new Error(
              `${label} static ${scope} closure eagerly imports external dependency: ${dependency}`,
            );
        }
      }
      if (bytes > maxBytes)
        throw new Error(
          `${label} static ${scope} closure grew to ${bytes} bytes across ${visited.size} modules; expected at most ${maxBytes} bytes. Modules: ${[...visited].sort().join(', ')}`,
        );
    },
  };
}

export function cliStartupPolicy(label: string, entry: string, maxBytes = 64 * 1024): Plugin {
  return cliStaticClosurePolicy(label, entry, maxBytes, {
    entry: true,
    forbidHeavySources: true,
  });
}

export function cliLazyModulePolicy(
  label: string,
  modulePath: string,
  maxBytes = 64 * 1024,
): Plugin {
  return cliStaticClosurePolicy(label, modulePath, maxBytes, {
    entry: false,
    forbidHeavySources: false,
  });
}
