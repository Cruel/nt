import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkEditorControlCoverage,
  countEditorCallbacks,
  editorRouteBindings,
} from './check-editor-control-coverage.mjs';

void test('the editor control audit catches unclassified modules and new callbacks', () => {
  const root = mkdtempSync(join(tmpdir(), 'noveltea-control-audit-'));
  try {
    mkdirSync(join(root, 'assets'));
    const file = join(root, 'assets', 'Editor.tsx');
    writeFileSync(file, 'export const Editor = () => <input onChange={() => {}} />;');
    const manifest = {
      schema: 1,
      categories: { assets: { disposition: 'authoring', evidence: 'asset-editor.test.tsx' } },
      files: { 'assets/Editor.tsx': { onChange: 1 } },
      routes: { 'asset-detail': 'AssetEditor' },
    };
    const routes = { 'asset-detail': 'AssetEditor' };
    assert.deepEqual(
      editorRouteBindings(
        "export const defaultEditorRegistrations: WorkbenchEditorRegistration[] = [{ type: 'asset-detail', component: AssetEditor, }];",
      ),
      routes,
    );
    assert.deepEqual(countEditorCallbacks('onBlur={() => {}} onChange={() => {}}'), {
      onBlur: 1,
      onChange: 1,
    });
    assert.deepEqual(checkEditorControlCoverage(root, manifest, routes), []);
    writeFileSync(
      file,
      'export const Editor = () => <input onChange={() => {}} onBlur={() => {}} />;',
    );
    assert.match(
      checkEditorControlCoverage(root, manifest, routes).join('\n'),
      /Unreviewed JSX control callback change/u,
    );
    writeFileSync(join(root, 'assets', 'Another.tsx'), 'export const Another = () => <div/>;');
    assert.match(
      checkEditorControlCoverage(root, manifest, routes).join('\n'),
      /Unclassified editor module/u,
    );
    assert.match(
      checkEditorControlCoverage(root, manifest, { ...routes, 'new-detail': 'NewEditor' }).join(
        '\n',
      ),
      /Unclassified editor route/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
