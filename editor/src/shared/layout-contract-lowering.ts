import type { LayoutContractData, LayoutStateShapeData } from './project-schema/authoring-layouts';

export function lowerLayoutStateShapeForWire(shape: LayoutStateShapeData): unknown {
  const common = {
    type: shape.type,
    nullable: shape.nullable,
    hasDefault: Object.prototype.hasOwnProperty.call(shape, 'defaultValue'),
    defaultValue: shape.defaultValue ?? null,
  };
  if (shape.type === 'array')
    return { ...common, items: lowerLayoutStateShapeForWire(shape.items) };
  if (shape.type === 'object')
    return {
      ...common,
      fields: Object.entries(shape.fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, field]) => ({
          id,
          required: field.required,
          shape: lowerLayoutStateShapeForWire(field.shape),
        })),
    };
  return common;
}

export function lowerLayoutContractForWire(contract: LayoutContractData) {
  return {
    inputs: Object.entries(contract.inputs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, input]) => ({
        id,
        type: input.type,
        nullable: input.nullable,
        hasDefault: Object.prototype.hasOwnProperty.call(input, 'defaultValue'),
        defaultValue: input.defaultValue ?? null,
      })),
    signals: Object.entries(contract.signals)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, signal]) => ({
        id,
        fields: Object.entries(signal.fields)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([fieldId, field]) => ({
            id: fieldId,
            type: field.type,
            nullable: field.nullable,
            required: field.required,
          })),
      })),
    state: contract.state ? lowerLayoutStateShapeForWire(contract.state) : null,
  };
}
