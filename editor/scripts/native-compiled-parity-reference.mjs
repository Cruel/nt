// Deliberately separate from the C++ lowering process. This reference reads
// only native-admitted JSON on stdin; it never opens a Project or runtime cache.
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

const input = JSON.parse(readFileSync(0, 'utf8'));
if (!Array.isArray(input.cases)) throw new Error('Expected admitted reference cases.');
const server = await createServer({
  configFile: false,
  root: new URL('../', import.meta.url).pathname,
  logLevel: 'silent',
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  appType: 'custom',
});
try {
  const { compileAuthoringProjectValue } = await server.ssrLoadModule(
    '/src/shared/authoring-compiler-lowering.ts',
  );
  const { authoringCollectionKeys } = await server.ssrLoadModule(
    '/src/shared/project-schema/authoring-collections.ts',
  );
  const { emptyEditorProjectState } = await server.ssrLoadModule(
    '/src/shared/project-schema/editor-project-state.ts',
  );
  const results = input.cases.map(({ name, project }) => {
    // Same boundary adapter as the shipped CLI: omitted empty collections and
    // editor-only state are not a second Project reader or schema admission.
    const admitted = { ...project };
    for (const family of authoringCollectionKeys) if (!(family in admitted)) admitted[family] = {};
    if (!admitted.editor) admitted.editor = emptyEditorProjectState();
    const result = compileAuthoringProjectValue(admitted);
    const again = compileAuthoringProjectValue(admitted);
    if (JSON.stringify(result) !== JSON.stringify(again))
      throw new Error(`${name}: reference Message, wire or diagnostics are nondeterministic`);
    return {
      name,
      ok: result.ok,
      diagnostics: result.diagnostics,
      stages: result.stages,
      ...(result.ok ? { project: result.project } : {}),
    };
  });
  process.stdout.write(JSON.stringify({ results }) + '\n');
} finally {
  await server.close();
}
