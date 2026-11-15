// Real Node-addon localization response, own-write and reopen certification.
// Uses a disposable copy, never the authored Feature Lab tree.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const addon = process.argv[2] ?? process.env.NOVELTEA_AUTHORING_NODE_ADDON;
assert.ok(addon, 'Pass the native authoring Node addon path.');
const binding = createRequire(import.meta.url)(path.resolve(addon));
const fixture =
  process.argv[3] ?? fileURLToPath(new URL('../../tests/projects/feature-lab/', import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'noveltea-localization-generations-'));
const project = path.join(scratch, 'feature-lab');
const character = 'characters/pilot-guide';
const translationId = 'bb028069-11e3-57f5-9912-4e8b3b12aeb9';
const translationPath = `/localization/translations/fr/${translationId}/text`;
let handle;

function parse(raw) {
  return JSON.parse(raw);
}

function accepted(operation, raw) {
  const result = parse(raw);
  assert.equal(result.accepted, true, `${operation}: ${result.error ?? 'native rejection'}`);
  return result;
}

function patch(revision, text) {
  return accepted(
    `Edit Character display name to ${text}`,
    binding.patch(
      handle,
      revision,
      JSON.stringify([
        {
          operation: 'replace',
          path: `/${character}/data/displayName`,
          value: text,
        },
      ]),
    ),
  );
}

function hasTranslationError(snapshot) {
  return snapshot.diagnostics.some((issue) => issue.path === translationPath);
}

try {
  await cp(fixture, project, {
    recursive: true,
    filter: (file) => !file.split(path.sep).includes('.noveltea'),
  });
  // Add a translation whose fixed text cannot supply the placeholder added
  // by a later unsaved Character edit. This makes stale localization snapshots
  // observable through the actual addon response diagnostics.
  const french = path.join(project, 'i18n/locales/fr.yaml');
  await writeFile(
    french,
    `${await readFile(french, 'utf8')}\n${translationId}:\n  text: Localized source title\n  origin: ai\n  review: needs-review\n  sourceFingerprint: fnv1a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n`,
  );
  handle = binding.open(project);
  const initial = parse(binding.snapshot(handle));
  assert.equal(initial.valid, true, JSON.stringify(initial.diagnostics));

  const invalid = patch(initial.workingRevision, 'Guide {name}');
  assert.equal(invalid.snapshot.valid, false);
  assert.equal(hasTranslationError(invalid.snapshot), true);
  const published = parse(binding.snapshot(handle));
  assert.equal(hasTranslationError(published), true, 'Addon snapshot publishes new diagnostics');

  const restored = patch(invalid.snapshot.workingRevision, 'Pilot Guide');
  assert.equal(restored.snapshot.valid, true, JSON.stringify(restored.snapshot.diagnostics));
  assert.equal(hasTranslationError(restored.snapshot), false);
  assert.equal(hasTranslationError(parse(binding.snapshot(handle))), false);
  const stale = parse(
    binding.patch(
      handle,
      invalid.snapshot.workingRevision,
      JSON.stringify([
        {
          operation: 'replace',
          path: `/${character}/data/displayName`,
          value: 'Stale',
        },
      ]),
    ),
  );
  assert.equal(stale.accepted, false, 'Stale revision cannot revive the invalid source');
  assert.equal(hasTranslationError(stale.snapshot), false);

  let revision = restored.snapshot.workingRevision;
  for (const label of ['Saved Character Name A', 'Saved Character Name B']) {
    const modified = patch(revision, label);
    assert.equal(modified.snapshot.valid, true);
    const saved = accepted(
      'Consecutive native owner Save',
      binding.saveOwners(
        handle,
        modified.snapshot.workingRevision,
        JSON.stringify([character]),
        false,
        'keep',
      ),
    );
    assert.equal(saved.snapshot.valid, true);
    assert.equal(hasTranslationError(saved.snapshot), false);
    revision = saved.snapshot.workingRevision;
  }
  assert.match(
    await readFile(path.join(project, 'records/characters/pilot-guide.yaml'), 'utf8'),
    /Saved Character Name B/,
  );
  binding.close(handle);
  handle = undefined;
  handle = binding.open(project);
  const reopened = accepted('Reinspect saved Character', binding.inspect(handle, character));
  assert.equal(reopened.snapshot.valid, true);
  assert.equal(
    reopened.snapshot.recordSnapshots[character].normalized.data.displayName,
    'Saved Character Name B',
  );
  assert.equal(hasTranslationError(reopened.snapshot), false);
  console.log('Native addon localization invalidation, rejection, own-write and reopen passed.');
} finally {
  if (handle !== undefined) binding.close(handle);
  await rm(scratch, { recursive: true, force: true });
}
