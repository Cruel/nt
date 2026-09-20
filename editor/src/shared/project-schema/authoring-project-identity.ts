import { z } from 'zod';
import { entityIdSchema } from './authoring-common';

export const projectIdentitySchema = z
  .object({
    id: entityIdSchema,
    name: z.string(),
    version: z.string().default('0.1.0'),
    author: z.string().default(''),
    description: z.string().default(''),
  })
  .strict();

export type ProjectIdentity = z.infer<typeof projectIdentitySchema>;
