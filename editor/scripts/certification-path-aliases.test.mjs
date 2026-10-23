import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCertificationPathAliases } from './certification-path-aliases.mjs';

void test('macOS lexical and canonical /tmp aliases normalize to the same fixture', () => {
  const fixtures = [
    ['/tmp/nt-c-123/fixture-legacy', '/private/tmp/nt-c-123/fixture-legacy', '<fixture>'],
    ['/tmp/nt-c-123/fixture-native', '/private/tmp/nt-c-123/fixture-native', '<fixture>'],
  ];
  for (const source of [
    '/tmp/nt-c-123/fixture-legacy',
    '/tmp/nt-c-123/fixture-native',
    '/private/tmp/nt-c-123/fixture-legacy',
    '/private/tmp/nt-c-123/fixture-native',
  ])
    assert.equal(
      normalizeCertificationPathAliases(
        source + '/.noveltea/build/shaders/derived/test.fs.bin',
        fixtures,
      ),
      '<fixture>/.noveltea/build/shaders/derived/test.fs.bin',
    );
  assert.equal(
    normalizeCertificationPathAliases('/private/tmp/unrelated/project', fixtures),
    '/private/tmp/unrelated/project',
  );
});

void test('Windows path aliases normalize both native and forward slash spellings', () => {
  const fixtures = [['C:\\Users\\runner\\Project', 'C:\\Users\\runner\\Project', '<project>']];
  assert.equal(
    normalizeCertificationPathAliases('C:\\Users\\runner\\Project\\output.bin', fixtures),
    '<project>\\output.bin',
  );
  assert.equal(
    normalizeCertificationPathAliases('C:/Users/runner/Project/output.bin', fixtures),
    '<project>/output.bin',
  );
});
