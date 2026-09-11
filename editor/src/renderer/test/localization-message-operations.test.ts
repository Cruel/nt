import { describe, expect, it } from 'vite-plus/test';
import { applyJsonPatch } from '../project/json-patch';
import { toJsonValue } from '../project/json-value';
import {
  identicalSourceReuseCandidates,
  promoteAndLinkLocalMessages,
  renameMessageValueReferencePatches,
} from '../project/localization-message-operations';
import { localizationMessageWorkflowViews } from '../../shared/authoring-localization-workflow';
import { synchronizeLocalizationMessageTracking } from '../../shared/authoring-localization-sync';
import { inlineTextContent } from '../../shared/project-schema/authoring-flow';
import {
  authoringProjectSchema,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultLayoutData } from '../../shared/project-schema/authoring-layouts';
import { defaultRoomData } from '../../shared/project-schema/authoring-rooms';
import { defaultVariableData } from '../../shared/project-schema/authoring-variables';

describe('localization Message operations', () => {
  it('renames every recognized named Message reference without touching ordinary strings', () => {
    const project = createAuthoringProject({ id: 'message-rename', name: 'Message Rename' });
    project.localization.messages['11111111-1111-4111-8111-111111111111'] = {
      kind: 'named',
      key: 'ui.old',
      source: 'Old',
    };
    const message = defaultVariableData('message');
    message.value = { $message: 'ui.old' };
    project.variables.prompt = { id: 'prompt', label: 'Prompt', data: message };
    const stringValue = defaultVariableData('string');
    stringValue.value = 'ui.old';
    project.variables.literal = { id: 'literal', label: 'Literal', data: stringValue };
    const room = defaultRoomData('Room');
    room.description = { markup: 'active-text', source: { kind: 'localized', key: 'ui.old' } };
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.msg("ui.old", { count = 1 })\n',
    };
    const renameLayout = defaultLayoutData('Rename', 'document');
    renameLayout.rml.sourceText = '<rml><body><nt-tr key="ui.old"></nt-tr></body></rml>';
    project.layouts.rename = { id: 'rename', label: 'Rename', data: renameLayout };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const renamePatches = renameMessageValueReferencePatches(tracked, 'ui.old', 'ui.new');

    const patched = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(tracked), [
        ...renamePatches,
        {
          op: 'replace',
          path: '/localization/messages/11111111-1111-4111-8111-111111111111/key',
          value: 'ui.new',
        },
      ] as never).document,
    );

    expect(patched.variables.prompt!.data.value).toEqual({ $message: 'ui.new' });
    expect(patched.variables.literal!.data.value).toBe('ui.old');
    expect(patched.rooms.room!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.new',
    });
    expect(patched.scripts.bootstrap!.data.source).toMatchObject({
      source: 'return Text.msg("ui.new", { count = 1 })\n',
    });
    expect(patched.layouts.rename!.data.rml.sourceText).toContain('key="ui.new"');
    expect(patched.localization.messages['11111111-1111-4111-8111-111111111111']).toMatchObject({
      key: 'ui.new',
    });
    expect(synchronizeLocalizationMessageTracking(patched).changed).toBe(false);
  });

  it('surfaces identical local source as informational reuse candidates', () => {
    const project = createAuthoringProject({ id: 'reuse', name: 'Reuse' });
    const first = defaultRoomData('First');
    first.description = inlineTextContent('Same words');
    const second = defaultRoomData('Second');
    second.description = inlineTextContent('Same words');
    const third = defaultRoomData('Third');
    third.description = inlineTextContent('Different words');
    project.rooms.first = { id: 'first', label: 'First', data: first };
    project.rooms.second = { id: 'second', label: 'Second', data: second };
    project.rooms.third = { id: 'third', label: 'Third', data: third };
    const messages = localizationMessageWorkflowViews(project);
    const canonical = messages.find((message) => message.usageNote?.includes('/rooms/first/'))!;

    expect(identicalSourceReuseCandidates(project, canonical.id)).toEqual([
      expect.objectContaining({ source: 'Same words', rewriteable: true }),
    ]);
  });

  it('promotes one stable local Message and transactionally links structured Lua and RML usages', () => {
    const project = createAuthoringProject({ id: 'promote', name: 'Promote' });
    const room = defaultRoomData('Room');
    room.description = inlineTextContent('Hello');
    project.rooms.room = { id: 'room', label: 'Room', data: room };
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source: 'return Text.tr("Hello", { who = player })\n',
    };
    const layout = defaultLayoutData('HUD', 'document');
    layout.rml.sourceText = '<rml><body><nt-tr class="copy">Hello</nt-tr></body></rml>';
    project.layouts.hud = { id: 'hud', label: 'HUD', data: layout };
    project.localization.locales.fr = { supported: false, parentLocale: null };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const views = localizationMessageWorkflowViews(tracked).filter(
      (message) => message.source === 'Hello',
    );
    const structured = views.find((message) => message.usageNote?.includes('/rooms/room/'))!;
    const lua = views.find((message) => message.usageNote?.includes('/scripts/'))!;
    const rml = views.find((message) => message.usageNote?.includes('/layouts/'))!;
    tracked.localization.translations.fr = {
      [lua.id]: {
        text: 'Bonjour',
        sourceFingerprint: lua.sourceFingerprint,
        origin: 'human',
        review: 'reviewed',
      },
    };

    const result = promoteAndLinkLocalMessages(tracked, structured.id, 'ui.shared.hello', [
      lua.id,
      rml.id,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promoted = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(tracked), result.patches as never).document,
    );

    expect(promoted.localization.messages[structured.id]).toEqual({
      kind: 'named',
      key: 'ui.shared.hello',
      source: 'Hello',
    });
    expect(promoted.localization.translations.fr?.[structured.id]).toMatchObject({
      text: 'Bonjour',
      origin: 'human',
      review: 'reviewed',
    });
    expect(promoted.localization.translations.fr?.[lua.id]).toBeUndefined();
    expect(promoted.rooms.room!.data.description.source).toEqual({
      kind: 'localized',
      key: 'ui.shared.hello',
    });
    expect(promoted.scripts.bootstrap!.data.source).toMatchObject({
      source: 'return Text.msg("ui.shared.hello", { who = player })\n',
    });
    expect(promoted.layouts.hud!.data.rml.sourceText).toBe(
      '<rml><body><nt-tr class="copy" key="ui.shared.hello"></nt-tr></body></rml>',
    );
    expect(synchronizeLocalizationMessageTracking(promoted).changed).toBe(false);
  });

  it('preserves canonical translator guidance and target provenance during promotion', () => {
    const project = createAuthoringProject({ id: 'guidance', name: 'Guidance' });
    project.scripts.bootstrap!.data.source = {
      kind: 'inline-lua',
      source:
        'return Text.tr("Continue", nil, { context = "Menu action", note = "Keep concise" })\n',
    };
    project.localization.locales.fr = { supported: false, parentLocale: null };
    const tracked = synchronizeLocalizationMessageTracking(project).project;
    const message = localizationMessageWorkflowViews(tracked).find(
      (candidate) => candidate.source === 'Continue',
    )!;
    tracked.localization.translations.fr = {
      [message.id]: {
        text: 'Continuer',
        sourceFingerprint: message.sourceFingerprint,
        origin: 'ai',
        review: 'reviewed',
        provider: 'test-provider',
        model: 'test-model',
      },
    };

    const result = promoteAndLinkLocalMessages(tracked, message.id, 'ui.menu.continue', []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promoted = authoringProjectSchema.parse(
      applyJsonPatch(toJsonValue(tracked), result.patches as never).document,
    );

    expect(promoted.localization.messages[message.id]).toEqual({
      kind: 'named',
      key: 'ui.menu.continue',
      source: 'Continue',
      context: 'Menu action',
      translatorNote: 'Keep concise',
    });
    expect(promoted.localization.translations.fr?.[message.id]).toMatchObject({
      text: 'Continuer',
      origin: 'ai',
      review: 'reviewed',
      provider: 'test-provider',
      model: 'test-model',
    });
  });

  it('refuses to link Messages when target work differs', () => {
    const project = createAuthoringProject({ id: 'conflict', name: 'Conflict' });
    const first = defaultRoomData('First');
    first.description = inlineTextContent('Same');
    const second = defaultRoomData('Second');
    second.description = inlineTextContent('Same');
    project.rooms.first = { id: 'first', label: 'First', data: first };
    project.rooms.second = { id: 'second', label: 'Second', data: second };
    project.localization.locales.fr = { supported: false, parentLocale: null };
    const views = localizationMessageWorkflowViews(project).filter(
      (message) => message.source === 'Same',
    );
    project.localization.translations.fr = {
      [views[0]!.id]: {
        text: 'Un',
        sourceFingerprint: views[0]!.sourceFingerprint,
        origin: 'human',
        review: 'reviewed',
      },
      [views[1]!.id]: {
        text: 'Deux',
        sourceFingerprint: views[1]!.sourceFingerprint,
        origin: 'human',
        review: 'reviewed',
      },
    };

    expect(promoteAndLinkLocalMessages(project, views[0]!.id, 'ui.same', [views[1]!.id])).toEqual({
      ok: false,
      message:
        "Target work for locale 'fr' differs; resolve that conflict before linking these Messages.",
    });
  });
});
