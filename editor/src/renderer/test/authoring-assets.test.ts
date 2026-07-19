import { describe, expect, it } from 'vite-plus/test';
import {
  defaultAssetIdFromFilename,
  inferAssetKindFromExtension,
  isSafeProjectAssetPath,
  parseAssetData,
  validateAssetAlias,
} from '../../shared/project-schema/authoring-assets';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { validateAuthoringProject } from '../../shared/project-schema/authoring-validation';

describe('authoring asset schema helpers', () => {
  it('infers common asset kinds deterministically', () => {
    expect(inferAssetKindFromExtension('cover.png')).toBe('image');
    expect(inferAssetKindFromExtension('body.ttf')).toBe('font');
    expect(inferAssetKindFromExtension('click.mp3')).toBe('audio');
    expect(inferAssetKindFromExtension('init.lua')).toBe('script');
    expect(inferAssetKindFromExtension('effect.sc')).toBe('shader-source');
    expect(inferAssetKindFromExtension('notes.md')).toBe('text');
    expect(inferAssetKindFromExtension('config.json')).toBe('data');
    expect(inferAssetKindFromExtension('blob.bin')).toBe('binary');
  });

  it('normalizes filenames into stable asset IDs', () => {
    expect(defaultAssetIdFromFilename('Title Background.png')).toBe('title-background');
    expect(defaultAssetIdFromFilename('123.wav')).toBe('asset-123');
  });

  it('validates safe project-relative asset paths', () => {
    expect(isSafeProjectAssetPath('assets/images/title.png')).toBe(true);
    expect(isSafeProjectAssetPath('/tmp/title.png')).toBe(false);
    expect(isSafeProjectAssetPath('assets/../title.png')).toBe(false);
    expect(isSafeProjectAssetPath('project:/assets/title.png')).toBe(false);
    expect(isSafeProjectAssetPath('assets\\title.png')).toBe(false);
  });

  it('validates aliases and asset records through project validation', () => {
    expect(validateAssetAlias('ui.click')).toBeNull();
    expect(validateAssetAlias('Bad Alias')).toContain('Alias must');
    const project = createAuthoringProject();
    project.assets.click = {
      id: 'click',
      label: 'Click',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/audio/click.mp3' },
        aliases: ['ui.click'],
      },
    };
    expect(parseAssetData(project.assets.click.data)?.kind).toBe('audio');
    expect(
      validateAuthoringProject(project).filter((diagnostic) => diagnostic.category === 'Assets'),
    ).toEqual([]);
    project.assets.other = {
      id: 'other',
      label: 'Other',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: '../bad.mp3' },
        aliases: ['ui.click'],
      },
    };
    const diagnostics = validateAuthoringProject(project).filter(
      (diagnostic) => diagnostic.category === 'Assets',
    );
    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes('safe project-relative')),
    ).toBe(true);
    expect(diagnostics.some((diagnostic) => diagnostic.message.includes('already assigned'))).toBe(
      true,
    );
  });
});
