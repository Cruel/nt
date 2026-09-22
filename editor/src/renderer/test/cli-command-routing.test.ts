import { describe, expect, it } from 'vite-plus/test';
import { classifyNovelTeaCliCommand } from '../../cli/command-routing';

describe('CLI semantic command routing', () => {
  it.each([
    ['project create', ['project', 'create', 'new'], 'none', false],
    ['project import', ['project', 'import', 'bundle', 'new'], 'none', false],
    ['project export', ['project', 'export', '--output', 'bundle'], 'read', false],
    ['agent sync', ['agent', 'sync'], 'none', false],
    ['comfyui status', ['comfyui', 'status'], 'none', true],
    ['comfyui workflows', ['comfyui', 'workflows'], 'none', true],
    ['comfyui verify', ['comfyui', 'verify', 'image.generate'], 'none', true],
    ['comfyui run', ['comfyui', 'run', 'image.generate'], 'opaque-write', false],
    ['validate', ['validate'], 'read', true],
    ['usages', ['usages', 'rooms', 'start'], 'read', true],
    ['asset audit', ['asset', 'audit'], 'read', true],
    ['asset import', ['asset', 'import', 'image.png'], 'transactional-write', false],
    ['entity create', ['entity', 'create', 'rooms', 'hall'], 'transactional-write', false],
    ['localization view', ['localization', 'view', 'fr'], 'read', true],
    ['localization sync', ['localization', 'sync'], 'transactional-write', false],
    ['shaders compile', ['shaders', 'compile'], 'read', false],
    ['test run', ['test', 'run'], 'read', true],
    ['package export', ['package', 'export'], 'read', false],
    ['platform profiles', ['platform', 'profiles'], 'read', true],
    ['platform export', ['platform', 'export'], 'opaque-write', false],
    ['platform template list', ['platform', 'template', 'list'], 'none', true],
    ['platform template install', ['platform', 'template', 'install', 'player.zip'], 'none', false],
    ['platform config init', ['platform', 'config', 'init', 'config.json'], 'none', false],
  ] as const)(
    '%s declares Project access and replay safety',
    (_name, command, projectAccess, replaySafe) => {
      expect(classifyNovelTeaCliCommand(command)).toMatchObject({ projectAccess, replaySafe });
    },
  );

  it('separates Project-directory requirements from resident authoring access', () => {
    expect(classifyNovelTeaCliCommand(['agent', 'sync'])).toMatchObject({
      requiresExistingProject: true,
      projectAccess: 'none',
    });
    expect(classifyNovelTeaCliCommand(['project', 'create', 'new'])).toMatchObject({
      requiresExistingProject: false,
      projectAccess: 'none',
    });
    expect(classifyNovelTeaCliCommand(['project', 'import', 'bundle', 'new'])).toMatchObject({
      requiresExistingProject: false,
      projectAccess: 'none',
    });
    expect(classifyNovelTeaCliCommand(['comfyui', 'run', 'image.generate'])).toMatchObject({
      requiresExistingProject: false,
      projectAccess: 'opaque-write',
    });
    expect(classifyNovelTeaCliCommand(['project', 'export', '--output', 'bundle'])).toMatchObject({
      requiresExistingProject: true,
      projectAccess: 'read',
    });
  });

  it('derives read versus transactional Project effects from command flags', () => {
    expect(
      classifyNovelTeaCliCommand(['asset', 'import', 'image.png', '--dry-run'])?.projectAccess,
    ).toBe('read');
    expect(classifyNovelTeaCliCommand(['localization', 'reconcile', 'fr'])?.projectAccess).toBe(
      'read',
    );
    expect(
      classifyNovelTeaCliCommand(['localization', 'reconcile', 'fr', '--apply'])?.projectAccess,
    ).toBe('transactional-write');
    expect(classifyNovelTeaCliCommand(['platform', 'export', '--check'])?.projectAccess).toBe(
      'read',
    );
  });

  it('declares the static/native completion tier before QuickJS initialization', () => {
    expect(classifyNovelTeaCliCommand(['daemon', 'status'])).toMatchObject({
      staticCompletion: 'daemon-control',
      quickJsRequiredAfterStaticMiss: false,
    });
    expect(classifyNovelTeaCliCommand(['shaderc', '--help'])).toMatchObject({
      staticCompletion: 'native-tool',
      quickJsRequiredAfterStaticMiss: false,
    });
    expect(classifyNovelTeaCliCommand(['validate'])).toMatchObject({
      staticCompletion: 'authoring-cache',
      quickJsRequiredAfterStaticMiss: true,
    });
    expect(classifyNovelTeaCliCommand(['test', 'run', 'smoke'])).toMatchObject({
      staticCompletion: 'runtime-cache',
      quickJsRequiredAfterStaticMiss: true,
      executionClass: 'disposable-heavy',
    });
  });

  it('classifies daemon execution semantics independently from static completion', () => {
    expect(classifyNovelTeaCliCommand(['validate'])).toMatchObject({
      executionClass: 'owner-short',
    });
    expect(classifyNovelTeaCliCommand(['entity', 'create', 'rooms', 'hall'])).toMatchObject({
      executionClass: 'owner-mutation',
    });
    expect(classifyNovelTeaCliCommand(['test', 'run'])).toMatchObject({
      staticCompletion: 'runtime-cache',
      executionClass: 'disposable-heavy',
    });
    expect(classifyNovelTeaCliCommand(['test', 'run-spec'])).toMatchObject({
      staticCompletion: 'runtime-cache',
      executionClass: 'disposable-heavy',
    });
  });

  it('declares stdin, streaming, and cancellation requirements semantically', () => {
    expect(classifyNovelTeaCliCommand(['test', 'run-spec'])).toMatchObject({
      stdin: 'json',
      streamedEvents: false,
      cancellation: true,
    });
    expect(
      classifyNovelTeaCliCommand(['localization', 'reconcile', 'fr', '--apply']),
    ).toMatchObject({
      stdin: 'json',
      projectAccess: 'transactional-write',
    });
    expect(classifyNovelTeaCliCommand(['comfyui', 'run', 'image.generate'])).toMatchObject({
      stdin: 'none',
      streamedEvents: true,
      cancellation: true,
    });
    expect(classifyNovelTeaCliCommand(['platform', 'export'])).toMatchObject({
      streamedEvents: true,
      cancellation: true,
    });
  });

  it('rejects command paths outside the canonical routing contract', () => {
    expect(classifyNovelTeaCliCommand(['entity', 'frobnicate'])).toBeNull();
    expect(classifyNovelTeaCliCommand(['platform', 'template', 'unknown'])).toBeNull();
  });
});
