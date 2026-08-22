import { parseRoomData } from './project-schema/authoring-rooms';
import {
  parseScriptModuleData,
  scriptModuleLifecycleMetadata,
} from './project-schema/authoring-script-modules';
import type { AuthoringProject } from './project-schema/authoring-project';

export const roomHookKindValues = [
  'can-enter',
  'can-leave',
  'reject-enter',
  'reject-leave',
  'before-enter',
  'after-enter',
  'before-leave',
  'after-leave',
  'compose',
] as const;

export type RoomHookKind = (typeof roomHookKindValues)[number];
export type HookSelectorKind = 'exact' | 'qualified-prefix' | 'catchall';
export type HookCapabilityProfile =
  | 'synchronous-expression'
  | 'gameplay-effect'
  | 'room-composition';

export interface TypedHookSelector {
  semanticKind: 'room';
  kind: HookSelectorKind;
  value: string;
  authored: string;
}

export interface HookRegistryRegistration {
  semanticKind: 'room';
  hook: RoomHookKind;
  selector: TypedHookSelector;
  moduleId: string;
  exportName: string;
  source: 'direct-definition' | 'bootstrap';
  sourcePath: string;
  capabilityProfile: HookCapabilityProfile;
}

export interface HookRegistryAnalysisDiagnostic {
  severity: 'error' | 'warning' | 'info';
  path: string;
  message: string;
  category: 'Scripts';
  code: string;
}

export interface HookRegistryExplanation {
  semanticKind: 'room';
  hook: RoomHookKind;
  target: string;
  winner?: HookRegistryRegistration;
  fallbacks: HookRegistryRegistration[];
  conflicts: HookRegistryRegistration[];
  dynamicUncertainty: boolean;
}

export interface HookRegistryAnalysis {
  registrations: HookRegistryRegistration[];
  diagnostics: HookRegistryAnalysisDiagnostic[];
  dynamicUncertainty: boolean;
  explain(hook: RoomHookKind, target: string): HookRegistryExplanation;
}

const hookKinds = new Set<string>(roomHookKindValues);

function capabilityProfile(hook: RoomHookKind): HookCapabilityProfile {
  if (hook === 'can-enter' || hook === 'can-leave') return 'synchronous-expression';
  if (hook === 'compose') return 'room-composition';
  return 'gameplay-effect';
}

export function parseTypedRoomHookSelector(value: string): TypedHookSelector | null {
  if (value === '*') return { semanticKind: 'room', kind: 'catchall', value: '', authored: value };
  if (value.length > 2 && value.endsWith('.*') && !value.slice(0, -2).includes('*'))
    return {
      semanticKind: 'room',
      kind: 'qualified-prefix',
      value: value.slice(0, -1),
      authored: value,
    };
  if (!value || value.includes('*')) return null;
  return { semanticKind: 'room', kind: 'exact', value, authored: value };
}

function selectorMatches(selector: TypedHookSelector, target: string): boolean {
  if (selector.kind === 'catchall') return true;
  if (selector.kind === 'qualified-prefix') return target.startsWith(selector.value);
  return target === selector.value;
}

function registrationKey(registration: HookRegistryRegistration): string {
  return [
    registration.semanticKind,
    registration.hook,
    registration.selector.kind,
    registration.selector.value,
  ].join('\u0000');
}

function compareSpecificity(
  left: HookRegistryRegistration,
  right: HookRegistryRegistration,
): number {
  const rank: Record<HookSelectorKind, number> = {
    exact: 3,
    'qualified-prefix': 2,
    catchall: 1,
  };
  const kindDifference = rank[right.selector.kind] - rank[left.selector.kind];
  if (kindDifference !== 0) return kindDifference;
  if (
    left.selector.kind === 'qualified-prefix' &&
    left.selector.value.length !== right.selector.value.length
  )
    return right.selector.value.length - left.selector.value.length;
  return left.sourcePath.localeCompare(right.sourcePath);
}

const literalRegistrationPattern =
  /\bhooks\s*\.\s*register\s*\(\s*(['"])([^'"\r\n]*)\1\s*,\s*(['"])([^'"\r\n]*)\3\s*,\s*(['"])([^'"\r\n]*)\5\s*,\s*(['"])([^'"\r\n]*)\7\s*,\s*(['"])([^'"\r\n]*)\9\s*\)/g;
const registrationCallPattern = /\bhooks\s*\.\s*register\s*\(/g;
const importCallPattern = /(?:^|[^\w.])import\s*\(/g;

function literalBootstrapRegistrations(
  project: AuthoringProject,
  diagnostics: HookRegistryAnalysisDiagnostic[],
): { registrations: HookRegistryRegistration[]; dynamicUncertainty: boolean } {
  const registrations: HookRegistryRegistration[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  let dynamicUncertainty = false;

  const visit = (moduleId: string) => {
    if (visited.has(moduleId) || visiting.has(moduleId)) return;
    visiting.add(moduleId);
    const record = project.scripts[moduleId];
    const data = parseScriptModuleData(record?.data);
    if (!data) {
      visiting.delete(moduleId);
      visited.add(moduleId);
      return;
    }
    if (data.source.kind !== 'inline-lua') {
      dynamicUncertainty = true;
      visiting.delete(moduleId);
      visited.add(moduleId);
      return;
    }

    const source = data.source.source;
    const matches = [...source.matchAll(literalRegistrationPattern)];
    const registrationCalls = [...source.matchAll(registrationCallPattern)].length;
    if (matches.length !== registrationCalls) dynamicUncertainty = true;

    matches.forEach((match, index) => {
      const semanticKind = match[2]!;
      const hook = match[4]!;
      const selectorText = match[6]!;
      const handlerModule = match[8]!;
      const exportName = match[10]!;
      const sourcePath = `/scripts/${moduleId}/data/source/source#hook-register-${index}`;
      if (semanticKind !== 'room') {
        diagnostics.push({
          severity: 'error',
          path: sourcePath,
          message: `Hook semantic kind '${semanticKind}' is unsupported; Room hooks require semantic kind 'room'.`,
          category: 'Scripts',
          code: 'script.invalid_hook_semantic_kind',
        });
        return;
      }
      if (!hookKinds.has(hook)) {
        diagnostics.push({
          severity: 'error',
          path: sourcePath,
          message: `Room hook kind '${hook}' is unsupported.`,
          category: 'Scripts',
          code: 'script.invalid_hook_kind',
        });
        return;
      }
      const selector = parseTypedRoomHookSelector(selectorText);
      if (!selector) {
        diagnostics.push({
          severity: 'error',
          path: sourcePath,
          message: `Room Hook Selector '${selectorText}' must be exact, a trailing qualified-prefix wildcard such as 'chapter.*', or '*'.`,
          category: 'Scripts',
          code: 'script.invalid_hook_selector',
        });
        return;
      }
      if (!handlerModule || !exportName) {
        diagnostics.push({
          severity: 'error',
          path: sourcePath,
          message: 'Hook handler module and export names must be non-empty.',
          category: 'Scripts',
          code: 'script.invalid_hook_handler',
        });
        return;
      }
      if (!project.scripts[handlerModule]) {
        diagnostics.push({
          severity: 'error',
          path: sourcePath,
          message: `Hook handler references missing Script Module '${handlerModule}'.`,
          category: 'Scripts',
          code: 'script.missing_hook_module',
        });
      }
      registrations.push({
        semanticKind: 'room',
        hook: hook as RoomHookKind,
        selector,
        moduleId: handlerModule,
        exportName,
        source: 'bootstrap',
        sourcePath,
        capabilityProfile: capabilityProfile(hook as RoomHookKind),
      });
    });

    const metadata = scriptModuleLifecycleMetadata(data);
    const importCalls = [...source.matchAll(importCallPattern)].length;
    if (metadata.literalImports.length !== importCalls) dynamicUncertainty = true;
    for (const dependency of metadata.literalImports) visit(dependency);
    visiting.delete(moduleId);
    visited.add(moduleId);
  };

  visit(project.bootstrapModule.$ref.id);
  return { registrations, dynamicUncertainty };
}

export function analyzeHookRegistry(project: AuthoringProject): HookRegistryAnalysis {
  const registrations: HookRegistryRegistration[] = [];
  const diagnostics: HookRegistryAnalysisDiagnostic[] = [];

  for (const [roomId, record] of Object.entries(project.rooms).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const room = parseRoomData(record.data);
    if (!room) continue;
    room.scriptHooks.forEach((mapping, index) => {
      registrations.push({
        semanticKind: 'room',
        hook: mapping.hook,
        selector: {
          semanticKind: 'room',
          kind: 'exact',
          value: roomId,
          authored: roomId,
        },
        moduleId: mapping.handler.module.$ref.id,
        exportName: mapping.handler.export.trim(),
        source: 'direct-definition',
        sourcePath: `/rooms/${roomId}/data/scriptHooks/${index}`,
        capabilityProfile: capabilityProfile(mapping.hook),
      });
    });
  }

  const bootstrap = literalBootstrapRegistrations(project, diagnostics);
  registrations.push(...bootstrap.registrations);

  const groups = new Map<string, HookRegistryRegistration[]>();
  for (const registration of registrations) {
    const key = registrationKey(registration);
    const group = groups.get(key) ?? [];
    group.push(registration);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const registration of group) {
      diagnostics.push({
        severity: 'error',
        path: registration.sourcePath,
        message: `Duplicate ${registration.semanticKind} '${registration.hook}' Hook Registry mapping for selector '${registration.selector.authored}'.`,
        category: 'Scripts',
        code: 'script.duplicate_hook_mapping',
      });
    }
  }

  const explain = (hook: RoomHookKind, target: string): HookRegistryExplanation => {
    const matching = registrations
      .filter(
        (registration) =>
          registration.semanticKind === 'room' &&
          registration.hook === hook &&
          selectorMatches(registration.selector, target),
      )
      .sort(compareSpecificity);
    const conflicts = matching.filter((registration) => {
      const group = groups.get(registrationKey(registration));
      return (group?.length ?? 0) > 1;
    });
    return {
      semanticKind: 'room',
      hook,
      target,
      winner: conflicts.length === 0 ? matching[0] : undefined,
      fallbacks: conflicts.length === 0 ? matching.slice(1) : matching,
      conflicts,
      dynamicUncertainty: bootstrap.dynamicUncertainty,
    };
  };

  return {
    registrations,
    diagnostics,
    dynamicUncertainty: bootstrap.dynamicUncertainty,
    explain,
  };
}
