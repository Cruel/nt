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
const { createAuthoringProject } =
  await import('../src/shared/project-schema/authoring-project.ts');
const { parseEditorProjectState } =
  await import('../src/shared/project-schema/editor-project-state.ts');
const { projectWorkspaceFiles } =
  await import('../src/shared/project-workspace/project-workspace-service.ts');
const { NOVELTEA_PROJECT_AGENTS_BOOTSTRAP, NOVELTEA_LOCAL_STATE_GITIGNORE_RULE } =
  await import('../src/shared/project-workspace/agent-bootstrap.ts');
const nativeCreateTemplate = createAuthoringProject({
  id: 'noveltea-native-create-template',
  name: 'NovelTea Native Creation Template',
});
const { layoutDataSchema } = await import('../src/shared/project-schema/authoring-layouts.ts');
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
const { nativeStructuralReferenceRules } =
  await import('../src/shared/authoring-dependency-graph.ts');
const { resolveAssetMemoryPolicy } =
  await import('../src/shared/project-schema/platform-export-contracts.ts');
const unicodeLowercase = {};
const casedRanges = [];
const caseIgnorableRanges = [];
const appendUnicodeRange = (ranges, point) => {
    const last = ranges.at(-1);
    if (last && last[1] === point - 1) last[1] = point;
    else ranges.push([point, point]);
};
const cased = /\p{Cased}/u;
const caseIgnorable = /\p{Case_Ignorable}/u;
for (let point = 0; point <= 0x10ffff; point += 1) {
  const source = String.fromCodePoint(point);
  if (cased.test(source)) {
    appendUnicodeRange(casedRanges, point);
    // Only cased code points have a lowercase mapping; avoid a million
    // locale conversions for code points that cannot participate in casing.
    const lower = source.toLocaleLowerCase('en-US');
    if (source !== lower) unicodeLowercase[point] = lower;
  }
  if (caseIgnorable.test(source)) appendUnicodeRange(caseIgnorableRanges, point);
}
const scopedExportValidation = {
  memoryDefaults: Object.fromEntries(
    ['linux', 'android', 'web'].map((target) => [
      target,
      Object.fromEntries(
        ['low', 'balanced', 'high'].map((preset) => [
          preset,
          resolveAssetMemoryPolicy(target, { kind: 'builtin', preset }),
        ]),
      ),
    ]),
  ),
  unicodeLowercase,
  casedRanges,
  caseIgnorableRanges,
};
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
        layouts: Object.fromEntries(
          Object.entries(layoutDataSchema.parse({}))
            .filter(([key]) => !['rml', 'rcss', 'lua'].includes(key))
            .map(([key, value]) => [`data.${key}`, value]),
        ),
        variables: { 'data.nullable': false, 'data.scope': 'global' },
        'project.yaml': { entrypoint: null, undefinedInteractionProgram: null },
        'i18n/project.yaml': { sourceLocaleLock: null },
        'editor.yaml': {
          'chapters.records': {},
          'chapters.assignments': {},
          'tags.records': {},
          'recordMetadata.*.*.tags': [],
          'recordMetadata.*': {},
        },
      },
      projectCreationFiles: {
        ...projectWorkspaceFiles(
          nativeCreateTemplate,
          parseEditorProjectState(nativeCreateTemplate.editor),
        ),
        'AGENTS.md': NOVELTEA_PROJECT_AGENTS_BOOTSTRAP,
        '.gitignore': `${NOVELTEA_LOCAL_STATE_GITIGNORE_RULE}\n`,
      },
      entityRecordSources: canonicalEntitySources,
      scopedExportValidation,
      structuralReferenceRules: nativeStructuralReferenceRules,
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
