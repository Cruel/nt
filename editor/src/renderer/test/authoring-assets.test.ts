import { describe, expect, it } from 'vite-plus/test';
import {
  defaultAssetIdFromFilename,
  inferAssetKindFromExtension,
  isSafeProjectAssetPath,
  parseAssetData,
  validateAssetAlias,
} from '../../shared/project-schema/authoring-assets';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('authoring asset schema helpers', () => {
  it('infers common asset kinds deterministically', () => {
    expect(inferAssetKindFromExtension('cover.png')).toBe('image');
    expect(inferAssetKindFromExtension('body.ttf')).toBe('font');
    expect(inferAssetKindFromExtension('click.mp3')).toBe('audio');
    expect(inferAssetKindFromExtension('intro.webm')).toBe('video');
    expect(inferAssetKindFromExtension('init.lua')).toBe('binary');
    expect(inferAssetKindFromExtension('effect.sc')).toBe('binary');
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

  it('validates Asset aliases and local record shape without a second Project validator', () => {
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
        imageMetadata: null,
      },
    };
    expect(parseAssetData(project.assets.click.data)?.kind).toBe('audio');
    project.assets.other = {
      id: 'other',
      label: 'Other',
      data: {
        kind: 'audio',
        source: { type: 'project-file', path: '../bad.mp3' },
        aliases: ['ui.click'],
        imageMetadata: null,
      },
    };
    expect(isSafeProjectAssetPath(project.assets.other.data.source.path)).toBe(false);
    // The local record codec preserves the raw path; native Project
    // validation, independently certified in C++, rejects unsafe paths.
    expect(parseAssetData(project.assets.other.data)?.source.path).toBe('../bad.mp3');
    expect(validateAssetAlias(project.assets.click.data.aliases[0]!)).toBeNull();
  });

  it('requires explicit current image metadata at persisted boundaries', () => {
    const missingImageMetadata = {
      kind: 'image',
      source: { type: 'project-file', path: 'assets/images/title.png' },
      aliases: [],
    };
    expect(parseAssetData(missingImageMetadata)).toBeNull();
    expect(parseAssetData({ ...missingImageMetadata, imageMetadata: null })).toBeNull();
    expect(
      parseAssetData({
        ...missingImageMetadata,
        imageMetadata: { width: 1920, height: 1080, hasAlpha: true, orientation: 1 },
      }),
    ).toBeDefined();
    expect(
      parseAssetData({
        kind: 'audio',
        source: { type: 'project-file', path: 'assets/audio/theme.ogg' },
        aliases: [],
      }),
    ).toBeNull();
  });
});
