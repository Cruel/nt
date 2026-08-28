import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import type { OwnerLocalProperty } from '../../../shared/project-schema/authoring-properties';
import {
  newTypedPropertyDraft,
  ownerLocalPropertyFromDraft,
  TypedPropertyFields,
  typedPropertyDraftFromOwnerLocal,
  type TypedPropertyDraft,
} from './TypedPropertyFields';

function formatValue(property: OwnerLocalProperty) {
  if (property.value === null) return 'null';
  return typeof property.value === 'string'
    ? JSON.stringify(property.value)
    : String(property.value);
}

export function OwnerLocalPropertiesEditor({
  ownerLabel,
  properties,
  onChange,
  usageCountFor,
}: {
  ownerLabel: string;
  properties: readonly OwnerLocalProperty[];
  onChange: (
    properties: OwnerLocalProperty[],
    change?: { kind: 'rename'; fromId: string; toId: string },
  ) => void;
  usageCountFor?: (propertyId: string) => number;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [draft, setDraft] = useState<TypedPropertyDraft>(() => newTypedPropertyDraft());
  const [message, setMessage] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    index: number;
    propertyId: string;
    usages: number;
  } | null>(null);

  const openNew = () => {
    setEditingIndex(-1);
    setDraft(newTypedPropertyDraft());
    setMessage(null);
  };

  const openEdit = (index: number) => {
    setEditingIndex(index);
    setDraft(typedPropertyDraftFromOwnerLocal(properties[index]!));
    setMessage(null);
  };

  const submit = () => {
    const parsed = ownerLocalPropertyFromDraft(draft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    const duplicateIndex = properties.findIndex(
      (property, index) => property.id === parsed.property.id && index !== editingIndex,
    );
    if (duplicateIndex >= 0) {
      setMessage(`Property '${parsed.property.id}' already exists on this owner.`);
      return;
    }
    if (editingIndex === -1) onChange([...properties, parsed.property]);
    else if (editingIndex !== null) {
      const previous = properties[editingIndex]!;
      onChange(
        properties.map((property, index) => (index === editingIndex ? parsed.property : property)),
        previous.id === parsed.property.id
          ? undefined
          : { kind: 'rename', fromId: previous.id, toId: parsed.property.id },
      );
    }
    setEditingIndex(null);
  };

  return (
    <section className="space-y-3 rounded-md border p-3" data-workbench-anchor="properties.local">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Properties</h3>
          <p className="text-xs text-muted-foreground">
            Typed state local to {ownerLabel}. Property IDs are scoped to this exact owner.
          </p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="size-4" /> Add Property
        </Button>
      </div>

      <div className="overflow-hidden rounded border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Property</th>
              <th className="w-px whitespace-nowrap px-3 py-2">Type</th>
              <th className="px-3 py-2">Value</th>
              <th className="w-px whitespace-nowrap px-3 py-2 text-right">Uses</th>
              <th className="w-px">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {properties.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-5 text-center text-xs text-muted-foreground">
                  No local Properties.
                </td>
              </tr>
            ) : null}
            {properties.map((property, index) => (
              <tr
                key={`${property.id}:${index}`}
                className="cursor-pointer border-t hover:bg-muted/30"
                onClick={() => openEdit(index)}
              >
                <td className="px-3 py-2">
                  <div className="font-medium">{property.label ?? property.id}</div>
                  {property.label ? (
                    <div className="font-mono text-[11px] text-muted-foreground">{property.id}</div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                  {property.type}
                  {property.nullable ? '?' : ''}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{formatValue(property)}</td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                  {usageCountFor?.(property.id) ?? 0}
                </td>
                <td className="px-1 py-1">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="text-destructive"
                    aria-label={`Delete ${property.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget({
                        index,
                        propertyId: property.id,
                        usages: usageCountFor?.(property.id) ?? 0,
                      });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={editingIndex !== null} onOpenChange={(open) => !open && setEditingIndex(null)}>
        <DialogPopup className="w-[min(620px,calc(100vw-2rem))]">
          <DialogTitle>{editingIndex === -1 ? 'Add Property' : 'Edit Property'}</DialogTitle>
          <DialogDescription>
            This declaration and concrete Value belong only to {ownerLabel}.
          </DialogDescription>
          <TypedPropertyFields draft={draft} onChange={setDraft} valueLabel="Value" />
          {message ? (
            <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
              {message}
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditingIndex(null)}>
              Cancel
            </Button>
            <Button onClick={submit}>
              {editingIndex === -1 ? 'Add Property' : 'Save changes'}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogPopup className="w-[min(480px,calc(100vw-2rem))]">
          <DialogTitle>Delete Property?</DialogTitle>
          <DialogDescription>
            {deleteTarget?.usages
              ? `Property '${deleteTarget.propertyId}' has ${deleteTarget.usages} known usage${deleteTarget.usages === 1 ? '' : 's'}. Deleting it will leave those references for validation to report.`
              : `Property '${deleteTarget?.propertyId ?? ''}' has no known usages.`}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleteTarget) return;
                onChange(properties.filter((_, index) => index !== deleteTarget.index));
                setDeleteTarget(null);
              }}
            >
              Delete Property
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
