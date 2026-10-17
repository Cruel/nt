import './native-schema/register-typescript.mjs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { generateNativeContracts, canonicalJson } = await import('./native-schema/generate.ts');
const { nativeSchemaSources } = await import('./native-schema/sources.ts');
const { sparseRecordYamlSourceDefaults } =
  await import('../src/shared/project-workspace/sparse-record-yaml-source.ts');
const { encodeSparseRecordYaml } =
  await import('../src/shared/project-workspace/sparse-record-yaml-source.ts');
const { encodeLayoutYaml } = await import('../src/shared/project-workspace/layout-yaml-source.ts');
const { encodeVariableYaml } =
  await import('../src/shared/project-workspace/variable-yaml-source.ts');
const { authoringCollectionMetadata } =
  await import('../src/shared/project-schema/authoring-collections.ts');
const defaultData = Object.fromEntries(
  await Promise.all(
    [
      ['archetypes', 'authoring-archetypes.ts', 'defaultArchetypeData'],
      ['characters', 'authoring-characters.ts', 'defaultCharacterData'],
      ['dialogues', 'authoring-dialogues.ts', 'defaultDialogueData'],
      ['interactables', 'authoring-interactables.ts', 'defaultInteractableData'],
      ['interactions', 'authoring-interactions.ts', 'defaultInteractionData'],
      ['layouts', 'authoring-layouts.ts', 'defaultLayoutData'],
      ['maps', 'authoring-maps.ts', 'defaultMapData'],
      ['materials', 'authoring-materials.ts', 'defaultMaterialData'],
      ['rooms', 'authoring-rooms.ts', 'defaultRoomData'],
      ['scenes', 'authoring-scenes.ts', 'defaultSceneData'],
      ['scripts', 'authoring-script-modules.ts', 'defaultScriptModuleData'],
      ['tests', 'authoring-tests.ts', 'defaultTestData'],
      ['variables', 'authoring-variables.ts', 'defaultVariableData'],
      ['verbs', 'authoring-verbs.ts', 'defaultVerbData'],
    ].map(async ([family, source, named]) => {
      const module = await import(`../src/shared/project-schema/${source}`);
      return [family, module[named]];
    }),
  ),
);
const canonicalEntitySources = Object.fromEntries(
  Object.entries(defaultData)
    .concat([
      [
        'animations',
        () => ({
          kind: 'animation',
          canvas: { width: 256, height: 256 },
          defaultMotionId: 'default',
          motions: [{ id: 'default', kind: 'sprite-sequence', frames: [], markers: [] }],
        }),
      ],
    ])
    .map(([family, makeData]) => {
      const record = {
        id: 'nt-template-id',
        label: 'NovelTeaTemplateLabel',
        data: makeData(
          family === 'archetypes' || family === 'variables' ? undefined : 'NovelTeaTemplateLabel',
        ),
      };
      if (['characters', 'rooms', 'interactables'].includes(family)) {
        record.archetype = null;
        record.archetypeOverrides = {};
        record.traits = [];
        if (family === 'interactables') record.defaultProperties = [];
        else record.localProperties = [];
      }
      const companions = {};
      if (family === 'layouts') {
        for (const channel of ['rml', 'rcss', 'lua']) {
          if (record.data[channel].sourceMode !== 'inline') continue;
          companions[`layout.${channel}`] = record.data[channel].sourceText;
          record.data[channel] = { sourceMode: 'file' };
        }
      }
      const source =
        family === 'variables'
          ? encodeVariableYaml(record)
          : family === 'layouts'
            ? encodeLayoutYaml(record)
            : encodeSparseRecordYaml(family, record);
      return [
        family,
        { labelPrefix: authoringCollectionMetadata[family].singularLabel, source, companions },
      ];
    }),
);
const { testSourceStepPayloads, testSourceExpectationPayloads, testSourceValueExpectations } =
  await import('../src/shared/project-schema/test-source-intent.ts');
const { defaultArchetypeConfiguration } =
  await import('../src/shared/project-schema/authoring-archetypes.ts');
const { materialContractRegistry } =
  await import('../src/shared/project-schema/material-contract-registry.generated.ts');
const { types, ...contracts } = generateNativeContracts(nativeSchemaSources);
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1 && !process.argv[outputIndex + 1])
  throw new Error('--output requires a directory');
const root =
  outputIndex === -1
    ? fileURLToPath(new URL('../../tools/project_authoring/generated/', import.meta.url))
    : path.resolve(process.argv[outputIndex + 1]);
const files = new Map([
  ['project_types.hpp', types],
  [
    'contracts.json',
    canonicalJson({
      schema: 'noveltea.native-authoring-contracts',
      ...contracts,
      sourceDefaults: {
        rooms: sparseRecordYamlSourceDefaults('rooms'),
        maps: sparseRecordYamlSourceDefaults('maps'),
        characters: sparseRecordYamlSourceDefaults('characters'),
        archetypes: sparseRecordYamlSourceDefaults('archetypes'),
        animations: sparseRecordYamlSourceDefaults('animations'),
        materials: sparseRecordYamlSourceDefaults('materials'),
        interactables: sparseRecordYamlSourceDefaults('interactables'),
        verbs: sparseRecordYamlSourceDefaults('verbs'),
        interactions: sparseRecordYamlSourceDefaults('interactions'),
        dialogues: sparseRecordYamlSourceDefaults('dialogues'),
        scenes: sparseRecordYamlSourceDefaults('scenes'),
        tests: sparseRecordYamlSourceDefaults('tests'),
        layouts: sparseRecordYamlSourceDefaults('layouts'),
      },
      entityRecordSources: canonicalEntitySources,
      testSourceIntent: {
        steps: testSourceStepPayloads,
        expectations: testSourceExpectationPayloads,
        valueTypes: testSourceValueExpectations,
      },
      archetypeTemplates: Object.fromEntries(
        ['room', 'character', 'interactable'].map((kind) => [
          kind,
          defaultArchetypeConfiguration(kind),
        ]),
      ),
      materialPresets: Object.fromEntries(
        materialContractRegistry.presets.map((preset) => [
          preset.id,
          {
            role: preset.role,
            hotspotImage: preset.capabilities.samplers.s_hotspotImage ?? null,
            hotspotMask: preset.capabilities.samplers.s_hotspotMask ?? null,
          },
        ]),
      ),
    }),
  ],
  [
    'operations.hpp',
    [
      '// Generated by editor/scripts/generate-native-schema.mjs. Do not edit.',
      '// clang-format off',
      '#pragma once',
      '#include <array>',
      '#include <string_view>',
      'namespace noveltea::authoring::generated {',
      'struct Operation { std::string_view id; std::string_view kind; };',
      `inline constexpr std::array<Operation, ${contracts.operations.length}> operations{{`,
      ...contracts.operations.map(({ id, kind }) => `  {"${id}", "${kind}"},`),
      '}};',
      '}',
      '// clang-format on',
      '',
    ].join('\n'),
  ],
]);
let stale = false;
await mkdir(root, { recursive: true });
for (const [name, content] of files) {
  const target = path.join(root, name);
  if (process.argv.includes('--check')) {
    if ((await readFile(target, 'utf8').catch(() => '')) !== content) {
      console.error(`Stale native schema artifact: ${target}`);
      stale = true;
    }
  } else await writeFile(target, content);
}
for (const name of await readdir(root))
  if (!files.has(name)) {
    console.error(`Unexpected generated artifact: ${name}`);
    stale = true;
  }
if (stale) process.exitCode = 1;
else
  console.log(
    `Native contracts: ${Object.keys(contracts.roots).length} roots, ${Object.keys(contracts.nodes).length} nodes, ${contracts.operations.length} operations.`,
  );
