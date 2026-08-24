import { z } from 'zod';
import { entityIdSchema } from './authoring-common';
import { roomRefSchema } from './authoring-flow';

const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const audioPurposeValues = [
  'music',
  'ambience',
  'voice',
  'sound-effect',
  'ui-sound',
] as const;
export type AudioPurpose = (typeof audioPurposeValues)[number];

export const audioPausePolicyValues = ['gameplay', 'owner', 'unscaled'] as const;
export type AudioPausePolicy = (typeof audioPausePolicyValues)[number];

export const audioLifetimeValues = ['desired-loop', 'one-shot'] as const;
export type AudioLifetime = (typeof audioLifetimeValues)[number];

export const audioCausalityValues = ['causal', 'disposable'] as const;
export type AudioCausality = (typeof audioCausalityValues)[number];

export const audioSkipBehaviorValues = ['stop', 'suppress', 'play'] as const;
export type AudioSkipBehavior = (typeof audioSkipBehaviorValues)[number];

export const audioPanSourceSchema = z.discriminatedUnion('kind', [
  strict({ kind: z.literal('scene-actor'), slotId: entityIdSchema }),
  strict({ kind: z.literal('room-anchor'), room: roomRefSchema, anchorId: entityIdSchema }),
]);
export type AudioPanSource = z.infer<typeof audioPanSourceSchema>;

export const audioPurposeMixSchema = strict({
  volume: z.number().finite().min(0).max(1),
  muted: z.boolean(),
});

export const voiceDuckingSchema = strict({
  enabled: z.boolean(),
  musicGain: z.number().finite().min(0).max(1),
  ambienceGain: z.number().finite().min(0).max(1),
});

export const projectAudioSettingsSchema = strict({
  purposes: strict({
    music: audioPurposeMixSchema,
    ambience: audioPurposeMixSchema,
    voice: audioPurposeMixSchema,
    'sound-effect': audioPurposeMixSchema,
    'ui-sound': audioPurposeMixSchema,
  }),
  voiceDucking: voiceDuckingSchema,
});

export const DEFAULT_PROJECT_AUDIO_SETTINGS = {
  purposes: {
    music: { volume: 1, muted: false },
    ambience: { volume: 1, muted: false },
    voice: { volume: 1, muted: false },
    'sound-effect': { volume: 1, muted: false },
    'ui-sound': { volume: 1, muted: false },
  },
  voiceDucking: { enabled: false, musicGain: 0.5, ambienceGain: 0.5 },
} as const;

export type ProjectAudioSettings = z.infer<typeof projectAudioSettingsSchema>;
