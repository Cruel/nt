#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registryPath = path.join(root, 'engine', 'material-contracts', 'material-contract-registry.json');
const tsOutputPath = path.join(
  root,
  'editor',
  'src',
  'shared',
  'project-schema',
  'material-contract-registry.generated.ts',
);
const cppOutputPath = path.join(
  root,
  'engine',
  'src',
  'render',
  'material_contract_registry.generated.hpp',
);
const checkOnly = process.argv.includes('--check');
const printTs = process.argv.includes('--print-ts');
const printCpp = process.argv.includes('--print-cpp');

function fail(message) {
  throw new Error(`Material contract registry: ${message}`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function expectArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}

function expectObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function expectString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

function uniqueIds(values, label) {
  const ids = values.map((value, index) => expectString(value.id, `${label}[${index}].id`));
  if (new Set(ids).size !== ids.length) fail(`${label} ids must be unique.`);
  return ids;
}

function validateRegistry(registry) {
  expectObject(registry, 'root');
  if (registry.schema !== 'noveltea.material-contract-registry') fail('schema identity is invalid.');
  if (registry.version !== 1) fail('version must remain 1 while NovelTea is unreleased.');

  const fingerprint = expectObject(registry.fingerprint, 'fingerprint');
  if (fingerprint.algorithm !== 'sha256') fail('fingerprint.algorithm must be sha256.');
  if (fingerprint.encoding !== 'canonical-json-v1')
    fail('fingerprint.encoding must be canonical-json-v1.');
  const expectedIncludes = [
    'contractIdentity',
    'role.id',
    'role.reservedInterface',
    'role.standardSemanticAvailability',
    'role.pipelineState',
    'preset.capabilities',
    'preset.defaultParameters',
    'preset.shader',
    'preset.preview.fixture',
  ];
  if (JSON.stringify(fingerprint.includes) !== JSON.stringify(expectedIncludes))
    fail('fingerprint.includes does not match the supported canonical input set.');

  const roles = expectArray(registry.roles, 'roles');
  const presets = expectArray(registry.presets, 'presets');
  const roleIds = uniqueIds(roles, 'roles');
  const presetIds = uniqueIds(presets, 'presets');
  const expectedRoleIds = [
    'engine-2d',
    'active-text',
    'rmlui-decorator',
    'postprocess',
    'hotspot-overlay',
  ];
  const expectedPresetIds = [
    'engine-2d',
    'active-text',
    'rmlui-decorator',
    'postprocess-tint',
    'hotspot-overlay-alpha',
    'hotspot-overlay-custom',
  ];
  if (JSON.stringify(roleIds) !== JSON.stringify(expectedRoleIds))
    fail('roles must define exactly the five current Material roles in canonical order.');
  if (JSON.stringify(presetIds) !== JSON.stringify(expectedPresetIds))
    fail('presets must define exactly the six current Material presets in canonical order.');

  const roleSet = new Set(roleIds);
  for (const [index, role] of roles.entries()) {
    const base = `roles[${index}]`;
    const reserved = expectObject(role.reservedInterface, `${base}.reservedInterface`);
    for (const key of [
      'attributes',
      'varyings',
      'predefinedUniforms',
      'rendererUniforms',
      'samplers',
    ])
      expectArray(reserved[key], `${base}.reservedInterface.${key}`);
    expectArray(role.standardSemanticAvailability, `${base}.standardSemanticAvailability`);
    expectObject(role.pipelineState, `${base}.pipelineState`);

    const samplerNames = new Set();
    const samplerStages = new Set();
    for (const [samplerIndex, sampler] of reserved.samplers.entries()) {
      const samplerBase = `${base}.reservedInterface.samplers[${samplerIndex}]`;
      expectString(sampler.name, `${samplerBase}.name`);
      expectString(sampler.semantic, `${samplerBase}.semantic`);
      expectString(sampler.physicalType, `${samplerBase}.physicalType`);
      expectString(sampler.sourceOwnership, `${samplerBase}.sourceOwnership`);
      if (!Number.isInteger(sampler.stage) || sampler.stage < 0 || sampler.stage > 255)
        fail(`${samplerBase}.stage must be a uint8 stage.`);
      expectArray(sampler.addressPolicy, `${samplerBase}.addressPolicy`);
      expectArray(sampler.filterPolicy, `${samplerBase}.filterPolicy`);
      if (sampler.addressPolicy.length < 1 || sampler.addressPolicy.length > 3)
        fail(`${samplerBase}.addressPolicy must contain one to three values.`);
      if (sampler.filterPolicy.length < 1 || sampler.filterPolicy.length > 3)
        fail(`${samplerBase}.filterPolicy must contain one to three values.`);
      if (samplerNames.has(sampler.name)) fail(`${base} reuses reserved sampler name '${sampler.name}'.`);
      if (samplerStages.has(sampler.stage)) fail(`${base} reuses reserved sampler stage ${sampler.stage}.`);
      samplerNames.add(sampler.name);
      samplerStages.add(sampler.stage);
    }
  }

  for (const [index, preset] of presets.entries()) {
    const base = `presets[${index}]`;
    const id = expectString(preset.id, `${base}.id`);
    const role = expectString(preset.role, `${base}.role`);
    if (!roleSet.has(role)) fail(`${base}.role references unknown role '${role}'.`);
    if (preset.contractIdentity !== `noveltea.material-preset:${id}:1`)
      fail(`${base}.contractIdentity must preserve the current V1 identity.`);
    expectObject(preset.shader, `${base}.shader`);
    expectObject(preset.capabilities, `${base}.capabilities`);
    expectObject(preset.defaultParameters, `${base}.defaultParameters`);
    expectObject(preset.preview, `${base}.preview`);
    expectObject(preset.compatibilityProjection, `${base}.compatibilityProjection`);

    const roleContract = roles.find((candidate) => candidate.id === role);
    const reservedSamplers = new Set(roleContract.reservedInterface.samplers.map((sampler) => sampler.name));
    for (const [slot, state] of Object.entries(preset.capabilities.samplers ?? {})) {
      if (!reservedSamplers.has(slot)) fail(`${base} declares unknown reserved sampler '${slot}'.`);
      if (!['required', 'optional', 'disabled'].includes(state))
        fail(`${base}.capabilities.samplers.${slot} has invalid state '${state}'.`);
    }
  }

  return { roles, presets, roleIds, presetIds };
}

function fingerprintInput(role, preset) {
  return {
    contractIdentity: preset.contractIdentity,
    role: {
      id: role.id,
      reservedInterface: role.reservedInterface,
      standardSemanticAvailability: role.standardSemanticAvailability,
      pipelineState: role.pipelineState,
    },
    preset: {
      capabilities: preset.capabilities,
      defaultParameters: preset.defaultParameters,
      shader: preset.shader,
      preview: { fixture: preset.preview.fixture },
    },
  };
}

function withFingerprints(registry) {
  const rolesById = new Map(registry.roles.map((role) => [role.id, role]));
  return {
    ...registry,
    presets: registry.presets.map((preset) => ({
      ...preset,
      contractFingerprint: sha256(canonicalJson(fingerprintInput(rolesById.get(preset.role), preset))),
    })),
  };
}

function tsString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function tsTuple(values) {
  return `[\n${values.map((value) => `  ${tsString(value)},`).join('\n')}\n]`;
}

function generatedTs(registry) {
  const roleIds = registry.roles.map((role) => role.id);
  const presetIds = registry.presets.map((preset) => preset.id);
  const fingerprintEntries = registry.presets
    .map((preset) => {
      const line = `  ${tsString(preset.id)}: ${tsString(preset.contractFingerprint)},`;
      return line.length <= 100
        ? line
        : `  ${tsString(preset.id)}:\n    ${tsString(preset.contractFingerprint)},`;
    })
    .join('\n');
  const projectedPresets = registry.presets
    .map(
      (preset, index) =>
        `    {\n      ...registry.presets[${index}],\n      contractFingerprint: materialContractFingerprints[${tsString(preset.id)}],\n    },`,
    )
    .join('\n');
  return `// AUTO-GENERATED by scripts/generate-material-contract-registry.mjs. DO NOT EDIT.\n\nimport registry from '../../../../engine/material-contracts/material-contract-registry.json';\n\nexport const materialContractRoleIds = ${tsTuple(roleIds)} as const;\n\nexport const materialContractPresetIds = ${tsTuple(presetIds)} as const;\n\nexport const materialContractFingerprints = {\n${fingerprintEntries}\n} as const;\n\nexport const materialContractRegistry = {\n  ...registry,\n  presets: [\n${projectedPresets}\n  ],\n} as const;\n\nexport type MaterialContractRoleId = (typeof materialContractRoleIds)[number];\nexport type MaterialContractPresetId = (typeof materialContractPresetIds)[number];\n`;
}

function cppString(value) {
  return JSON.stringify(String(value));
}

function identifier(value) {
  return value.replace(/[^A-Za-z0-9_]/gu, '_');
}

function policyInitializer(values) {
  const padded = [...values, '', '', ''].slice(0, 3);
  return `MaterialContractPolicyValues{.values = {${padded.map(cppString).join(', ')}}, .count = ${values.length}}`;
}

function interfaceSlotInitializer(slot) {
  return `{.name = ${cppString(slot.name)}, .physical_type = ${cppString(slot.physicalType)}, .semantic = ${cppString(slot.semantic)}}`;
}

function generatedCpp(registry) {
  const lines = [
    '// AUTO-GENERATED by scripts/generate-material-contract-registry.mjs. DO NOT EDIT.',
    '#pragma once',
    '',
    '#include "noveltea/render/material_contract.hpp"',
    '',
    '#include <array>',
    '#include <string_view>',
    '',
    '// clang-format off',
    'namespace noveltea::generated_material_contracts {',
    '',
    `inline constexpr std::string_view fingerprint_algorithm = ${cppString(registry.fingerprint.algorithm)};`,
    `inline constexpr std::string_view fingerprint_encoding = ${cppString(registry.fingerprint.encoding)};`,
    '',
  ];

  for (const role of registry.roles) {
    const id = identifier(role.id);
    const groups = [
      ['attributes', role.reservedInterface.attributes],
      ['varyings', role.reservedInterface.varyings],
      ['predefined_uniforms', role.reservedInterface.predefinedUniforms],
      ['renderer_uniforms', role.reservedInterface.rendererUniforms],
    ];
    for (const [name, values] of groups) {
      lines.push(`inline constexpr std::array<MaterialContractInterfaceSlot, ${values.length}> role_${id}_${name}{{`);
      for (const value of values) lines.push(`    ${interfaceSlotInitializer(value)},`);
      lines.push('}};', '');
    }

    lines.push(`inline constexpr std::array<MaterialContractSamplerSlot, ${role.reservedInterface.samplers.length}> role_${id}_samplers{{`);
    for (const sampler of role.reservedInterface.samplers) {
      lines.push('    {');
      lines.push(`        .name = ${cppString(sampler.name)},`);
      lines.push(`        .semantic = ${cppString(sampler.semantic)},`);
      lines.push(`        .physical_type = ${cppString(sampler.physicalType)},`);
      lines.push(`        .stage = ${sampler.stage},`);
      lines.push(`        .source_ownership = ${cppString(sampler.sourceOwnership)},`);
      lines.push(`        .address_policy = ${policyInitializer(sampler.addressPolicy)},`);
      lines.push(`        .filter_policy = ${policyInitializer(sampler.filterPolicy)},`);
      lines.push(`        .observation = ${cppString(sampler.observation)},`);
      lines.push('    },');
    }
    lines.push('}};', '');

    lines.push(`inline constexpr std::array<MaterialContractStandardSemantic, ${role.standardSemanticAvailability.length}> role_${id}_standard_semantics{{`);
    for (const semantic of role.standardSemanticAvailability)
      lines.push(`    {.semantic = ${cppString(semantic.semantic)}, .logical_type = ${cppString(semantic.logicalType)}},`);
    lines.push('}};', '');
  }

  lines.push(`inline constexpr std::array<MaterialRoleContract, ${registry.roles.length}> roles{{`);
  for (const role of registry.roles) {
    const id = identifier(role.id);
    lines.push('    {');
    lines.push(`        .id = ${cppString(role.id)},`);
    lines.push(`        .attributes = role_${id}_attributes,`);
    lines.push(`        .varyings = role_${id}_varyings,`);
    lines.push(`        .predefined_uniforms = role_${id}_predefined_uniforms,`);
    lines.push(`        .renderer_uniforms = role_${id}_renderer_uniforms,`);
    lines.push(`        .samplers = role_${id}_samplers,`);
    lines.push(`        .standard_semantics = role_${id}_standard_semantics,`);
    lines.push('        .pipeline_state = {');
    lines.push(`            .blend = ${cppString(role.pipelineState.blend)},`);
    lines.push(`            .output_alpha = ${cppString(role.pipelineState.outputAlpha)},`);
    lines.push('        },');
    lines.push('    },');
  }
  lines.push('}};', '');

  for (const preset of registry.presets) {
    const id = identifier(preset.id);
    const capabilities = Object.entries(preset.capabilities.samplers ?? {});
    lines.push(`inline constexpr std::array<MaterialContractCapability, ${capabilities.length}> preset_${id}_sampler_capabilities{{`);
    for (const [slot, state] of capabilities)
      lines.push(`    {.slot = ${cppString(slot)}, .state = ${cppString(state)}},`);
    lines.push('}};', '');
  }

  lines.push(`inline constexpr std::array<MaterialPresetContract, ${registry.presets.length}> presets{{`);
  for (const preset of registry.presets) {
    const id = identifier(preset.id);
    lines.push('    {');
    lines.push(`        .id = ${cppString(preset.id)},`);
    lines.push(`        .label = ${cppString(preset.label)},`);
    lines.push(`        .role = ${cppString(preset.role)},`);
    lines.push(`        .contract_identity = ${cppString(preset.contractIdentity)},`);
    lines.push(`        .contract_fingerprint = ${cppString(preset.contractFingerprint)},`);
    lines.push(`        .vertex_source = ${cppString(preset.shader.vertexSource)},`);
    lines.push(`        .fragment_source = ${cppString(preset.shader.fragmentSource)},`);
    lines.push(`        .varying_definition = ${cppString(preset.shader.varyingDefinition)},`);
    lines.push(`        .program_name = ${cppString(preset.shader.programName)},`);
    lines.push(`        .sampler_capabilities = preset_${id}_sampler_capabilities,`);
    lines.push(`        .default_parameters_json = ${cppString(canonicalJson(preset.defaultParameters))},`);
    lines.push('        .preview = {');
    lines.push(`            .fixture = ${cppString(preset.preview.fixture)},`);
    lines.push(`            .geometry = ${cppString(preset.preview.geometry)},`);
    lines.push(`            .background = ${cppString(preset.preview.background)},`);
    lines.push('        },');
    lines.push(`        .compatibility_projection_json = ${cppString(canonicalJson(preset.compatibilityProjection))},`);
    lines.push('    },');
  }
  lines.push(
    '}};',
    '',
    '} // namespace noveltea::generated_material_contracts',
    '// clang-format on',
  );
  return `${lines.join('\n')}\n`;
}

async function updateOutput(filename, expected) {
  let current = null;
  try {
    current = await readFile(filename, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current === expected) return false;
  if (checkOnly) {
    process.stderr.write(`Generated Material contract output is stale: ${path.relative(root, filename)}\n`);
    process.exitCode = 1;
    return true;
  }
  await writeFile(filename, expected, 'utf8');
  return true;
}

const raw = JSON.parse(await readFile(registryPath, 'utf8'));
validateRegistry(raw);
const registry = withFingerprints(raw);
if (printTs) {
  process.stdout.write(generatedTs(registry));
} else if (printCpp) {
  process.stdout.write(generatedCpp(registry));
} else {
  await updateOutput(tsOutputPath, generatedTs(registry));
  await updateOutput(cppOutputPath, generatedCpp(registry));
}
