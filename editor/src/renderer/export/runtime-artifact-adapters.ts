import type { ShaderCompileResponse } from '../../shared/editor-tooling';
import { parseShaderCompileResponse } from '../../shared/shader-compile-contract';
import type {
  RuntimeArtifactPathAdapter,
  RuntimeArtifactShaderCompilerAdapter,
} from '../../shared/runtime-artifact-preparation';
import { useProjectStore } from '../project/project-store';
import { useShaderCompileStore } from '../shaders/shader-compile-store';
import { joinHostPath } from '../host-filesystem-path';
import { sha256PrefixedBytes } from '../../shared/web-crypto';

async function sha256TextSourceBytes(
  text: string,
  hadUtf8Bom: boolean,
): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(text);
  if (!hadUtf8Bom) return sha256PrefixedBytes(bytes);
  const withBom = new Uint8Array(bytes.byteLength + 3);
  withBom.set([0xef, 0xbb, 0xbf]);
  withBom.set(bytes, 3);
  return sha256PrefixedBytes(withBom);
}

export const rendererRuntimeArtifactPaths: RuntimeArtifactPathAdapter = {
  resolveProjectSource(projectRoot, source) {
    if (/^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(source)) return joinHostPath(source);
    const clean = source.replace(/^[/\\]+/, '');
    return projectRoot ? joinHostPath(projectRoot, clean) : clean;
  },
  shaderAssetRoot(projectRoot) {
    return projectRoot ? joinHostPath(projectRoot, '.noveltea', 'build') : undefined;
  },
  async prepareOpaqueVideo(_projectRoot, request) {
    const projectSessionId = useProjectStore.getState().projectSessionId;
    if (!projectSessionId) throw new Error('Video preparation requires an active Project session.');
    return window.noveltea.prepareOpaqueVideo(projectSessionId, request);
  },
  async readProjectTextSources(_projectRoot, entries) {
    const projectSessionId = useProjectStore.getState().projectSessionId;
    if (!projectSessionId)
      return entries.map(({ assetId }) => ({ status: 'unavailable' as const, assetId }));
    const response = await window.noveltea.readProjectTextSources({
      projectSessionId,
      entries: entries.map((entry) => ({
        readKey: entry.assetId,
        projectRelativePath: entry.projectRelativePath,
        // Source reads accept XXH3-128 only. Packaging pins SHA-256 independently below.
        expectedContentHash: null,
      })),
    });
    const byKey = new Map(response.entries.map((entry) => [entry.readKey, entry]));
    return Promise.all(
      entries.map(async ({ assetId, projectRelativePath, expectedContentHash }) => {
        const result = byKey.get(assetId);
        if (result?.status !== 'ready') return { status: 'unavailable' as const, assetId };
        const contentHash = await sha256TextSourceBytes(result.text, result.hadUtf8Bom);
        if (expectedContentHash !== null && contentHash !== expectedContentHash)
          return { status: 'unavailable' as const, assetId };
        return {
          status: 'ready' as const,
          assetId,
          projectRelativePath,
          // Export/runtime Asset integrity remains cryptographic SHA-256,
          // independent of the local editor's XXH3 source revision.
          contentHash,
          text: result.text,
          byteLength:
            new TextEncoder().encode(result.text).byteLength + (result.hadUtf8Bom ? 3 : 0),
        };
      }),
    );
  },
};

export const rendererShaderCompilerAdapter: RuntimeArtifactShaderCompilerAdapter = {
  async compile(shaderProject, options) {
    useShaderCompileStore.setState({
      compiling: true,
      lastOptions: options,
      diagnostics: [],
      outputs: [],
      authoringOutputs: [],
      error: null,
    });
    try {
      const projectSessionId = useProjectStore.getState().projectSessionId;
      if (!projectSessionId)
        throw new Error('Shader compilation requires an active Project session.');
      const response = parseShaderCompileResponse(
        await window.noveltea.compileShaders(projectSessionId, shaderProject, {
          forceRebuild: options.forceRebuild,
          shaderVariants: options.shaderVariants,
        }),
      );
      useShaderCompileStore.getState().setResult(response, options);
      return response;
    } catch (error) {
      const response: ShaderCompileResponse = {
        ok: false,
        success: false,
        outputs: [],
        diagnostics: [
          { severity: 'error', message: error instanceof Error ? error.message : String(error) },
        ],
        error: error instanceof Error ? error.message : String(error),
      };
      useShaderCompileStore.getState().setResult(response, options);
      return response;
    }
  },
};
