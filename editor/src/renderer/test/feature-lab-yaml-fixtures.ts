import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';

const root = resolve(process.cwd(), '../tests/projects/feature-lab');

/** Read the committed, canonical YAML Project owners, not staged JSON fixtures. */
export function featureLabYamlFiles(family: string): string[] {
  return readdirSync(resolve(root, 'records', family))
    .filter((name) => name.endsWith('.yaml'))
    .sort();
}

export function featureLabYamlRecord(family: string, filename: string): unknown {
  const path = `records/${family}/${filename}`;
  return projectWorkspaceSourceCodec(path).decode(featureLabYamlSource(family, filename));
}

export function featureLabYamlSource(family: string, filename: string): string {
  return readFileSync(resolve(root, 'records', family, filename), 'utf8');
}
