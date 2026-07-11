import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve(process.argv[2] ?? 'dist');
const tag = process.argv[3] ?? 'unknown';
const sha = (file) => createHash('sha256').update(readFileSync(path.join(directory, file))).digest('hex');
const templates = readdirSync(directory).filter((name) => name.endsWith('.template.json')).sort().map((name) => {
  const descriptorData = readFileSync(path.join(directory, name));
  const descriptor = JSON.parse(descriptorData);
  if (descriptor.format !== 'noveltea.player-template' || descriptor.formatVersion !== 1) throw new Error(`Unsupported descriptor ${name}`);
  if (!readdirSync(directory).includes(descriptor.artifacts.archive)) throw new Error(`Missing archive ${descriptor.artifacts.archive}`);
  return {
    templateId: descriptor.templateId, buildId: descriptor.buildId, platform: descriptor.platform,
    architecture: descriptor.architecture, buildFlavor: descriptor.buildFlavor,
    archive: descriptor.artifacts.archive, archiveSha256: sha(descriptor.artifacts.archive),
    descriptorSha256: createHash('sha256').update(descriptorData).digest('hex'),
    symbols: descriptor.artifacts.symbols,
    sbom: `${descriptor.templateId}.SBOM.cdx.json`,
    notices: `${descriptor.templateId}.THIRD_PARTY_NOTICES.txt`,
    provenance: `https://github.com/${process.env.GITHUB_REPOSITORY}/attestations`,
  };
});
const index = { format: 'noveltea.template-registry-index', formatVersion: 1, generatedAt: new Date().toISOString(), release: tag, templates };
writeFileSync(path.join(directory, 'noveltea-player-template-registry.json'), `${JSON.stringify(index, null, 2)}\n`);
