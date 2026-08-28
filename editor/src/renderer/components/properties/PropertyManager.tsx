import type {
  OwnerDefaultProperty,
  OwnerLocalProperty,
  PropertyOwnerKind,
  TraitDefinition,
} from '../../../shared/project-schema/authoring-properties';
import {
  OwnerLocalPropertiesEditor,
  type OwnerPropertyTraitState,
} from './OwnerLocalPropertiesEditor';
import {
  OwnerDefaultPropertiesEditor,
  type InheritedDefaultProperty,
} from './OwnerDefaultPropertiesEditor';

interface CommonProps {
  ownerLabel: string;
  ownerKind: PropertyOwnerKind;
  traits: Readonly<Record<string, TraitDefinition>>;
  attachedTraits: readonly string[];
  usageCountFor?: (propertyId: string) => number;
  traitColorFor?: (traitId: string) => string | null;
}

export type PropertyManagerProps =
  | (CommonProps & {
      mode: 'value';
      properties: readonly OwnerLocalProperty[];
      inheritedProperties?: readonly InheritedDefaultProperty[];
      inheritedTraits?: readonly string[];
      onChange: (
        properties: OwnerLocalProperty[],
        change?: { kind: 'rename'; fromId: string; toId: string },
      ) => void;
      onTraitStateChange: (state: OwnerPropertyTraitState) => void;
    })
  | (CommonProps & {
      mode: 'default';
      properties: readonly OwnerDefaultProperty[];
      inheritedProperties?: readonly InheritedDefaultProperty[];
      inheritedTraits?: readonly string[];
      onChange: (state: { properties: OwnerDefaultProperty[]; traits: string[] }) => void;
    });

export function PropertyManager(props: PropertyManagerProps) {
  if (props.mode === 'value') {
    return (
      <OwnerLocalPropertiesEditor
        ownerLabel={props.ownerLabel}
        properties={props.properties}
        onChange={props.onChange}
        usageCountFor={props.usageCountFor}
        traits={props.traits}
        ownerKind={props.ownerKind}
        attachedTraits={props.attachedTraits}
        inheritedProperties={props.inheritedProperties}
        inheritedTraits={props.inheritedTraits}
        traitColorFor={props.traitColorFor}
        onTraitStateChange={props.onTraitStateChange}
      />
    );
  }
  return (
    <OwnerDefaultPropertiesEditor
      ownerLabel={props.ownerLabel}
      ownerKind={props.ownerKind}
      properties={props.properties}
      inheritedProperties={props.inheritedProperties}
      inheritedTraits={props.inheritedTraits}
      attachedTraits={props.attachedTraits}
      traits={props.traits}
      onChange={props.onChange}
      usageCountFor={props.usageCountFor}
      traitColorFor={props.traitColorFor}
    />
  );
}
