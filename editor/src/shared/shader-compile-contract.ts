import { z } from 'zod';
import type { ShaderCompileResponse } from './editor-tooling';
import { shaderVariantValues } from './shader-variants';

const shaderCompileDiagnosticSchema = z
  .object({
    severity: z.enum(['info', 'warning', 'error']),
    code: z.string().min(1).optional(),
    shader: z.string().min(1).optional(),
    stage: z.enum(['vertex', 'fragment']).optional(),
    variant: z.enum(shaderVariantValues).optional(),
    sourcePath: z.string().optional(),
    outputPath: z.string().optional(),
    commandLine: z.string().optional(),
    exitCode: z.number().int().optional(),
    message: z.string(),
    path: z.string().optional(),
    category: z.string().optional(),
    boundaries: z.array(z.enum(['authoring', 'runtime-package', 'platform-export'])).optional(),
    ownerPaths: z.array(z.string()).optional(),
  })
  .strict();

const shaderCompileOutputSchema = z
  .object({
    program: z.string().min(1),
    programIdentity: z.string().min(1),
    stage: z.enum(['vertex', 'fragment']),
    variant: z.enum(shaderVariantValues),
    sourceIdentity: z.string().min(1),
    dependencies: z.array(z.string().min(1)),
    dependencyRevisions: z.array(
      z
        .object({
          identity: z.string().min(1),
          contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        })
        .strict(),
    ),
    outputPath: z.string().min(1),
    runtimePath: z.string().min(1),
    cacheKey: z.string().min(1),
    byteHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    byteSize: z.number().int().nonnegative().refine(Number.isSafeInteger),
    reflectedInputs: z.array(
      z
        .object({
          name: z.string().min(1),
          kind: z.enum(['uniform', 'sampled-image']),
          type: z.string().min(1),
          arraySize: z.number().int().positive(),
        })
        .strict(),
    ),
    browserPayload: z.string().optional(),
    cacheHit: z.boolean(),
  })
  .strict();

export const shaderCompileResponseSchema = z
  .object({
    ok: z.boolean(),
    success: z.boolean(),
    diagnostics: z.array(shaderCompileDiagnosticSchema),
    outputs: z.array(shaderCompileOutputSchema),
    error: z.string().optional(),
  })
  .strict();

export function parseShaderCompileResponse(value: unknown): ShaderCompileResponse {
  const parsed = shaderCompileResponseSchema.safeParse(value);
  if (parsed.success) return parsed.data as ShaderCompileResponse;
  const message = 'Shader compiler returned a malformed response.';
  return {
    ok: false,
    success: false,
    outputs: [],
    diagnostics: [
      {
        severity: 'error',
        code: 'shader.compile.response-invalid',
        message,
      },
    ],
    error: message,
  };
}
