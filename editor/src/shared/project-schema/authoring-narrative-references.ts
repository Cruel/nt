import { z } from 'zod';

// A locator into the independent canonical Story catalog, not an engine reference.
// Do not resolve these IDs during gameplay compilation: projects without Story
// catalogs remain fully valid and mappings are never runtime authority.
const narrativeIdPattern =
  /^(?:creative-direction|arc|milestone|event|character|fact|world-entity|relationship|revelation|choice-point|puzzle|authored-content|narrative-position)\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const narrativeIdSchema = z
  .string()
  .regex(
    narrativeIdPattern,
    'Narrative ID must be a canonical typed Story ID (for example event.trial).',
  );

// Many-to-many association; order and repetition are authoring concerns only.
// No Story directory needs to exist for a link to be stored.
export const narrativeRefsSchema = z.array(narrativeIdSchema);

export const narrativeRefsField = { narrativeRefs: narrativeRefsSchema.optional() };
export type NarrativeId = z.infer<typeof narrativeIdSchema>;
