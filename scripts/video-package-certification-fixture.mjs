// Disposable YAML Feature Lab fixture shared by the video package certifications.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The editor owns the authoring YAML dependency; certification runs with its installed toolchain.
const { parse, stringify } = createRequire(path.join(repo, 'editor/package.json'))('yaml');

export async function editYaml(file, update) {
  const document = parse(await fs.readFile(file, 'utf8'));
  update(document);
  // C++ source admission also accepts YAML 1.1: keys such as 'y' must not
  // accidentally become boolean keys when the fixture is rewritten.
  await fs.writeFile(file, stringify(document, { defaultKeyType: 'QUOTE_DOUBLE' }));
}

export async function createVideoCertificationProject(work, label) {
  const dir = path.join(work, label, 'project');
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.cp(path.join(repo, 'tests/projects/feature-lab'), dir, { recursive: true });
  const projectFile = path.join(dir, 'project.yaml');
  const roomFile = path.join(dir, 'records/rooms/world-composition.yaml');
  const animationFile = path.join(dir, 'records/animations/opaque-color-loop.yaml');
  await editYaml(projectFile, (project) => {
    project.entrypoint = { kind: 'room', id: 'world-composition' };
    project.settings.ui.systemLayouts = {};
  });
  await editYaml(roomFile, (room) => {
    room.data.presentationSpace.defaultView = {
      center: { x: 1200, y: 675 }, zoom: 1, rotationDegrees: 0,
    };
  });
  return { dir, projectFile, animationFile };
}

export async function changeVideoSource(dir, filename, mimeType, extension) {
  const file = path.join(dir, 'records/assets/opaque-colors.yaml');
  const relative = 'assets/video/' + filename;
  const bytes = await fs.readFile(path.join(dir, relative));
  await editYaml(file, (asset) => {
    Object.assign(asset.data, {
      source: { type: 'project-file', path: relative },
      mimeType,
      extension,
      byteSize: bytes.length,
      contentHash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    });
  });
}
