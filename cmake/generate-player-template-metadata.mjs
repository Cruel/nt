import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const installed = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const version = process.argv[4];
const statusPath = path.join(installed, 'vcpkg', 'status');
if (!existsSync(statusPath)) throw new Error(`Missing vcpkg status database: ${statusPath}`);
const packages = readFileSync(statusPath, 'utf8').split(/\r?\n\r?\n/).map((paragraph) => Object.fromEntries(paragraph.split(/\r?\n/).filter((line) => line.includes(': ')).map((line) => { const at = line.indexOf(': '); return [line.slice(0, at), line.slice(at + 2)]; }))).filter((item) => item.Package && item.Version && item.Status?.endsWith(' installed')).sort((a, b) => a.Package.localeCompare(b.Package));
const components = packages.map((item) => ({ type: 'library', name: item.Package, version: item.Version, ...(item.Architecture ? { properties: [{ name: 'vcpkg:architecture', value: item.Architecture }] } : {}) }));
writeFileSync(path.join(output, 'SBOM.cdx.json'), `${JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, metadata: { component: { type: 'application', name: 'noveltea-player', version } }, components }, null, 2)}\n`);
const share = path.join(installed, 'share'); const notices = ['NovelTea player third-party notices', ''];
for (const item of packages) { const copyright = path.join(share, item.Package, 'copyright'); notices.push(`===== ${item.Package} ${item.Version} =====`); notices.push(existsSync(copyright) ? readFileSync(copyright, 'utf8').trim() : 'No vcpkg copyright file was installed for this package.'); notices.push(''); }
writeFileSync(path.join(output, 'licenses', 'THIRD_PARTY_NOTICES.txt'), `${notices.join('\n')}\n`);
