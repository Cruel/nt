import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hex = /^[0-9a-f]{64}$/;
const textDecoder = new TextDecoder('utf-8', { fatal: true });
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// This index is part of the current player-template contract, not a separately versioned format.
export async function verifyEngineNoticeIndex(templateRoot, descriptor, sbom) {
  if (descriptor.artifacts?.notices !== 'licenses/index.json')
    throw new Error('Player template must declare licenses/index.json, not an aggregate notice.');
  const indexFile = path.join(templateRoot, 'licenses/index.json');
  const indexBytes = await readFile(indexFile);
  if (indexBytes.length > 1024 * 1024)
    throw new Error('Engine license index exceeds the runtime reader limit.');
  const index = JSON.parse(textDecoder.decode(indexBytes));
  if (index.format !== 'noveltea.engine-licenses' ||
      Object.keys(index).sort().join(',') !== 'components,format' ||
      !Array.isArray(index.components) || index.components.length === 0)
    throw new Error('Invalid engine license index.');
  const inventory = new Map((descriptor.files ?? []).map((file) => [file.path, file]));
  const indexed = new Set(['licenses/index.json']);
  const names = new Set();
  let previous = '';
  for (const component of index.components) {
    if (!component || Object.keys(component).sort().join(',') !== 'component,displayName,files,version' ||
        typeof component.component !== 'string' || !component.component.trim() ||
        typeof component.displayName !== 'string' || !component.displayName.trim() ||
        typeof component.version !== 'string' || !component.version.trim() ||
        !Array.isArray(component.files) || component.files.length === 0)
      throw new Error('Malformed engine license component.');
    if (names.has(component.component) || (previous && compare(previous, component.component) >= 0))
      throw new Error(`Duplicate or unordered engine license component '${component.component}'.`);
    names.add(component.component);
    previous = component.component;
    for (const file of component.files) {
      if (!file || Object.keys(file).sort().join(',') !== 'path,sha256,size' ||
          typeof file.path !== 'string' ||
          !/^licenses\/[a-z0-9-]+--[a-z0-9-]+\.txt$/.test(file.path) ||
          !file.path.startsWith(`licenses/${slug(component.component)}--`) ||
          !Number.isSafeInteger(file.size) || file.size <= 0 ||
          !hex.test(file.sha256) || indexed.has(file.path))
        throw new Error(`Invalid or duplicated engine license path '${file?.path}'.`);
      indexed.add(file.path);
      const declaration = inventory.get(file.path);
      if (!declaration || declaration.size !== file.size ||
          declaration.sha256 !== file.sha256 || (declaration.role && declaration.role !== 'notice'))
        throw new Error(`Engine license '${file.path}' does not match the template file inventory.`);
      const data = await readFile(path.join(templateRoot, file.path));
      if (data.length !== file.size || data.length > 1024 * 1024 || sha256(data) !== file.sha256)
        throw new Error(`Engine license integrity mismatch for '${file.path}'.`);
      const text = textDecoder.decode(data);
      if (!text.trim() ||
          /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f]/.test(text) ||
          /No dependency notice file was found|Resolved dependency license texts are collected|PLACEHOLDER LICENSE/i.test(text))
        throw new Error(`Missing or placeholder engine license text in '${file.path}'.`);
    }
  }
  if (!inventory.has('licenses/index.json'))
    throw new Error('Engine license index is missing from template file inventory.');
  if (indexed.size - 1 > 512)
    throw new Error('Engine license index exceeds the runtime viewer limit.');
  const declaredLicenses = [...inventory.keys()].filter((name) => name.startsWith('licenses/')).sort();
  if (declaredLicenses.join('\n') !== [...indexed].sort().join('\n'))
    throw new Error('Template licenses/ files and engine license index are not an exact set.');
  const declaredRuntimeNotices = (descriptor.runtimeDependencies ?? [])
    .filter((dependency) => dependency.kind === 'notice').map((dependency) => dependency.path).sort();
  if (declaredRuntimeNotices.join('\n') !== declaredLicenses.join('\n'))
    throw new Error('Template runtime notice dependencies and license index differ.');
  if (!Array.isArray(sbom.components) || sbom.components.length !== index.components.length)
    throw new Error('SBOM component inventory differs from engine license index.');
  const sbomComponents = sbom.components.map(({ name, version }) => `${name}\u0000${version}`).sort();
  const indexComponents = index.components.map(({ component, version }) => `${component}\u0000${version}`).sort();
  if (sbomComponents.join('\n') !== indexComponents.join('\n'))
    throw new Error('SBOM components/versions are not covered exactly by engine licenses.');
  return { componentCount: index.components.length, fileCount: indexed.size - 1 };
}
