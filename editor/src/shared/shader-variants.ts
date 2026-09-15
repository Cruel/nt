import { z } from 'zod';

export const shaderVariantValues = ['glsl-330', 'essl-300', 'metal'] as const;
export const shaderVariantSchema = z.enum(shaderVariantValues);
export type ShaderVariant = (typeof shaderVariantValues)[number];
