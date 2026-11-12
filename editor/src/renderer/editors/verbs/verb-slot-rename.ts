import type { VerbData } from '../../../shared/project-schema/authoring-verbs';

/** A semantic slot reference can occur in rules, nested conditions/programs,
 * Offers and named inline text. Remap it without changing unrelated values. */
export function remapNamedSlotReferences<T>(data: T, previousId: string, nextId: string): T {
  const placeholder = `{${previousId}}`;
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    const current = value as Record<string, unknown>;
    const next = Object.fromEntries(
      Object.entries(current).map(([key, child]) => [
        key,
        key === 'slotId' && child === previousId ? nextId : walk(child),
      ]),
    );
    if (current.kind === 'inline' && typeof current.text === 'string')
      next.text = current.text.replaceAll(placeholder, `{${nextId}}`);
    return next;
  }

  return walk(data) as T;
}

/** One coordinated Verb identity remap; its associated Interaction rules are
 * patched in the same native command by the authored record transaction. */
export function renameVerbSlot(data: VerbData, previousId: string, nextId: string): VerbData {
  const remapped = remapNamedSlotReferences(data, previousId, nextId);
  return {
    ...remapped,
    slots: remapped.slots.map((slot) => (slot.id === previousId ? { ...slot, id: nextId } : slot)),
    bindingOrder: remapped.bindingOrder.map((id) => (id === previousId ? nextId : id)),
  };
}
