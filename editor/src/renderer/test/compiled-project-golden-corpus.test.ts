import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileAuthoringProject } from '../../shared/authoring-compiler';
import type { CompiledProjectWireV1 } from '../../shared/project-schema/compiled-project';
import {
  comprehensiveGoldenProject,
  dialogueProgramGoldenProject,
  inheritancePropertiesLocalizationGoldenProject,
  interactionProgramGoldenProject,
  minimalGoldenProject,
  resourceGoldenProject,
  sceneProgramGoldenProject,
} from './fixtures/compiled-project-golden-projects';

function golden(name: string): string {
  return readFileSync(
    resolve('src/renderer/test/fixtures/compiled-project-golden', `${name}.json`),
    'utf8',
  ).trimEnd();
}

function compileFixture(project: ReturnType<typeof minimalGoldenProject>): CompiledProjectWireV1 {
  const result = compileAuthoringProject(project);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  if (!result.ok) throw new Error('Golden authoring project did not compile.');
  return result.project;
}

function expectGolden(
  name: string,
  project: ReturnType<typeof minimalGoldenProject>,
): CompiledProjectWireV1 {
  const result = compileAuthoringProject(project);
  expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics, null, 2)).toBe(true);
  if (!result.ok) throw new Error('Golden authoring project did not compile.');
  expect(result.canonicalJson).toBe(golden(name));
  return result.project;
}

function collectKinds(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKinds(entry, result));
    return result;
  }
  if (value === null || typeof value !== 'object') return result;
  const record = value as Record<string, unknown>;
  if (typeof record.kind === 'string') result.add(record.kind);
  Object.values(record).forEach((entry) => collectKinds(entry, result));
  return result;
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe('compiled project cross-language golden corpus', () => {
  it('keeps the minimal complete document byte-stable', () => {
    expectGolden('minimal', minimalGoldenProject());
  });

  it('keeps every compiled definition, declaration, localization, and resource family byte-stable', () => {
    const project = expectGolden('comprehensive', comprehensiveGoldenProject());
    for (const definitions of Object.values(project.definitions)) expect(definitions.length).toBeGreaterThan(0);
  });

  it('keeps inheritance, properties, and localization edge data byte-stable', () => {
    expectGolden(
      'inheritance-properties-localization',
      inheritancePropertiesLocalizationGoldenProject(),
    );
  });

  it('keeps typed gameplay-resource references and both resource source modes byte-stable', () => {
    expectGolden('resources', resourceGoldenProject());
  });

  it('keeps every Scene instruction variant byte-stable', () => {
    expectGolden('scene-program', sceneProgramGoldenProject());
  });

  it('keeps every Dialogue graph variant byte-stable', () => {
    expectGolden('dialogue-program', dialogueProgramGoldenProject());
  });

  it('keeps every Interaction matching and instruction variant byte-stable', () => {
    expectGolden('interaction-program', interactionProgramGoldenProject());
  });

  it('covers the closed decoder vocabulary rather than only nominal collection records', () => {
    const comprehensive = compileFixture(comprehensiveGoldenProject());
    const resources = compileFixture(resourceGoldenProject());
    const scene = compileFixture(sceneProgramGoldenProject());
    const dialogue = compileFixture(dialogueProgramGoldenProject());
    const interaction = compileFixture(interactionProgramGoldenProject());
    const kinds = collectKinds([comprehensive, resources, scene, dialogue, interaction]);

    const requiredKinds = [
      'active-room', 'actor-cue', 'always', 'any', 'any-interactable', 'apply-effect',
      'asset', 'audio-cue', 'call-dialogue', 'call-scene', 'character', 'choice',
      'circle', 'conditional-branch', 'dialogue', 'end', 'exact', 'inline', 'inline-lua',
      'interactable', 'inventory', 'layout', 'line', 'localized', 'lua-expression',
      'lua-predicate', 'material', 'move-interactable', 'next', 'notify', 'nowhere',
      'point', 'predicate', 'rect', 'redirect', 'return', 'room', 'room-placement',
      'run-lua', 'run-lua-effect', 'scene', 'sequence', 'set-background',
      'set-interactable-state', 'set-layout', 'set-variable', 'show-text', 'transition',
      'variable', 'variable-comparison', 'verb', 'wait-duration', 'wait-input',
    ];
    for (const kind of requiredKinds) expect(kinds, `missing compiled kind '${kind}'`).toContain(kind);

    const opening = scene.definitions.scenes.find((candidate) => candidate.id === 'opening')!;
    expect(sorted(new Set(opening.program.instructions.map((instruction) => instruction.kind)))).toEqual(sorted([
      'set-background', 'actor-cue', 'call-dialogue', 'show-text', 'audio-cue',
      'set-variable', 'run-lua', 'wait-duration', 'wait-input', 'conditional-branch',
      'choice', 'set-layout', 'transition',
    ]));

    const intro = dialogue.definitions.dialogues.find((candidate) => candidate.id === 'intro')!;
    expect(sorted(new Set(intro.program.blocks.map((block) => block.kind)))).toEqual([
      'choice', 'redirect', 'sequence',
    ]);
    expect(sorted(new Set(intro.program.edges.map((edge) => edge.kind)))).toEqual(['choice', 'next']);
    expect(sorted(new Set(intro.program.blocks.flatMap((block) => (
      block.kind === 'sequence' ? block.segments.map((segment) => segment.kind) : []
    ))))).toEqual(['line', 'run-lua']);

    const actions = interaction.definitions.interactions.find((candidate) => candidate.id === 'actions')!;
    expect(sorted(new Set(actions.rules.map((rule) => rule.context.kind)))).toEqual([
      'active-room', 'any', 'predicate', 'room-placement',
    ]);
    expect(sorted(new Set(actions.rules.flatMap((rule) => rule.operands.map((operand) => operand.kind))))).toEqual([
      'any-interactable', 'exact',
    ]);
    expect(sorted(new Set(actions.rules.flatMap((rule) => rule.program.instructions.map((instruction) => instruction.kind))))).toEqual([
      'apply-effect', 'call-dialogue', 'call-scene', 'move-interactable', 'notify',
      'set-interactable-state',
    ]);
    expect(sorted(new Set(actions.rules.map((rule) => rule.program.outcome)))).toEqual([
      'handled', 'unhandled',
    ]);
    expect(sorted(new Set(actions.rules.flatMap((rule) => rule.program.instructions.flatMap((instruction) => (
      instruction.kind === 'move-interactable' ? [instruction.target.kind] : []
    )))))).toEqual(['inventory', 'nowhere', 'room-placement']);

    expect(sorted(new Set(resources.resources.assets.map((asset) => asset.kind)))).toEqual([
      'audio', 'binary', 'data', 'font', 'image', 'script', 'shader-source', 'text',
    ]);
    expect(sorted(new Set(resources.resources.layouts.flatMap((layout) => [
      layout.rml.kind,
      layout.rcss.kind,
      layout.lua.kind,
    ])))).toEqual(['asset', 'inline']);
    expect(sorted(new Set(resources.resources.scripts.map((script) => script.source.kind)))).toEqual([
      'asset', 'inline-lua',
    ]);
    expect(sorted(new Set(comprehensive.variables.map((variable) => variable.type)))).toEqual([
      'boolean', 'enum', 'integer', 'number', 'string',
    ]);
    expect(sorted(new Set(comprehensive.properties.map((property) => property.type)))).toEqual([
      'boolean', 'enum', 'integer', 'number', 'string',
    ]);
    expect(sorted(new Set(comprehensive.properties.map((property) => property.persistence)))).toEqual([
      'Save', 'Session',
    ]);
  });

  it('ignores editor metadata and authoring collection insertion order', () => {
    const first = comprehensiveGoldenProject();
    first.editor.recordMetadata = {
      rooms: { start: { color: '#ffffff', sortKey: '9', tags: [] } },
    };
    const reordered = comprehensiveGoldenProject();
    reordered.rooms = {
      tower: reordered.rooms.tower!,
      hall: reordered.rooms.hall!,
      start: reordered.rooms.start!,
    };
    reordered.editor.recordMetadata = {
      rooms: { hall: { color: '#000000', sortKey: '1', tags: [] } },
    };
    const left = compileAuthoringProject(first);
    const right = compileAuthoringProject(reordered);
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (left.ok && right.ok) expect(left.canonicalJson).toBe(right.canonicalJson);
  });
});
