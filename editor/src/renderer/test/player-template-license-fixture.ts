import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Minimum genuine Desktop/Web license inventory for template integration fixtures. */
export function createTemplateLicenseFixture(templateRoot: string) {
  const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const relative = 'licenses/fixture-dependency--license.txt';
  const text = 'MIT License\nCopyright (c) 2026 Fixture Dependency\n';
  mkdirSync(path.join(templateRoot, 'licenses'), { recursive: true });
  writeFileSync(path.join(templateRoot, relative), text);
  writeFileSync(
    path.join(templateRoot, 'licenses/index.json'),
    JSON.stringify({
      format: 'noveltea.engine-licenses',
      components: [
        {
          component: 'fixture-dependency',
          displayName: 'Fixture Dependency',
          version: '1.0',
          files: [{ path: relative, size: Buffer.byteLength(text), sha256: sha256(text) }],
        },
      ],
    }),
  );
  writeFileSync(
    path.join(templateRoot, 'SBOM.cdx.json'),
    JSON.stringify({
      bomFormat: 'CycloneDX',
      components: [{ name: 'fixture-dependency', version: '1.0' }],
    }),
  );
  const files = [relative, 'licenses/index.json', 'SBOM.cdx.json'].map((name) => {
    const data = readFileSync(path.join(templateRoot, name));
    return {
      path: name,
      size: data.length,
      mode: 0o644,
      sha256: sha256(data),
      role: name.startsWith('licenses/') ? ('notice' as const) : ('support' as const),
    };
  });
  const runtimeDependencies = [
    { path: relative, kind: 'notice' as const },
    { path: 'licenses/index.json', kind: 'notice' as const },
  ];
  return { files, runtimeDependencies };
}
