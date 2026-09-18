import { z } from 'zod';
import { assetDataSchema } from './authoring-assets';
import { entityIdSchema } from './authoring-common';

export const assetRecordSchema = z
  .object({
    id: entityIdSchema,
    label: z.string().min(1, 'Record label is required.'),
    description: z.string().optional(),
    data: assetDataSchema.strict(),
  })
  .strict();
