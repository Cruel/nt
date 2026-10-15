import { z } from 'zod';

export type NativeOperationKind = 'refinement' | 'overwrite' | 'transform';
export interface NativeOperationRegistration {
  readonly id: string;
  readonly kind: NativeOperationKind;
}

export const nativeOperationCatalog = {
  'animation.loop-range': 'refinement',
  'animation.source-range': 'refinement',
  'asset.attachment-path': 'refinement',
  'asset.validate': 'refinement',
  'editor.recovery-pointer': 'refinement',
  'export.android-profile': 'refinement',
  'export.localization-policy': 'refinement',
  'hotspot.bounds': 'refinement',
  'hotspot.motion-track': 'refinement',
  'layout.contract-input': 'refinement',
  'layout.state-shape': 'refinement',
  'localization.locale-id': 'refinement',
  'localization.lock-source': 'transform',
  'localization.pattern.plural': 'refinement',
  'localization.pattern.select': 'refinement',
  'localization.validate': 'refinement',
  'lua.dependencies.empty': 'overwrite',
  'lua.dependencies.unique': 'refinement',
  'material.application-parameter': 'refinement',
  'material.parameter-override': 'refinement',
  'material.shader-override': 'refinement',
  'material.texture-override': 'refinement',
  'project.canonical-inventory': 'refinement',
  'project.notice-extension': 'refinement',
  'project.notice-path': 'refinement',
  'property.default-unique': 'refinement',
  'property.default-value': 'refinement',
  'property.local-unique': 'refinement',
  'property.local-value': 'refinement',
  'scene.material-value': 'refinement',
  'string.trim': 'overwrite',
  'string.utf16-length': 'refinement',
  'trait.definition': 'refinement',
  'trait.property': 'refinement',
  'value.default': 'overwrite',
  'verb.qualified-pattern': 'refinement',
  'verb.validate': 'refinement',
  'workspace.trait-key': 'refinement',
} as const satisfies Readonly<Record<string, NativeOperationKind>>;
export type NativeOperationId = keyof typeof nativeOperationCatalog;

const registrations = new WeakMap<object, NativeOperationRegistration>();

function register(operation: object, id: NativeOperationId, kind: NativeOperationKind): void {
  if (nativeOperationCatalog[id] !== kind) throw new Error(`Unregistered native ${kind}: ${id}`);
  const prior = registrations.get(operation);
  if (prior && prior.id !== id)
    throw new Error(`Conflicting native operation: ${prior.id} / ${id}`);
  registrations.set(operation, { id, kind });
}

export function readNativeOperation(operation: object): NativeOperationRegistration | undefined {
  return registrations.get(operation);
}

export function nativeCheck<T extends z.core.$ZodCheck>(id: NativeOperationId, check: T): T {
  const kind = check._zod.def.check === 'overwrite' ? 'overwrite' : 'refinement';
  register(check, id, kind);
  return check;
}

// Preserve the exact Zod instance and its inference; only the final operation is registered.
export function nativeOperation<T extends z.ZodType>(id: NativeOperationId, schema: T): T {
  const definition = schema._zod.def;
  if (definition.type === 'pipe') {
    const output = (schema as unknown as z.ZodPipe)._zod.def.out;
    if (output._zod.def.type !== 'transform') throw new Error(`Not a transform: ${id}`);
    register(output, id, 'transform');
  } else {
    const check = definition.checks?.at(-1);
    if (!check) throw new Error(`Missing native operation: ${id}`);
    nativeCheck(id, check);
  }
  return schema;
}
