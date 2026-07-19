import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vite-plus/test';
import {
  createSourceEditorCompletionSource,
  luaRuntimeCompletions,
  rcssCompletions,
  rmlAttributeCompletions,
  rmlElementCompletions,
  shaderCompletions,
  sourceEditorCompletionOptions,
  type SourceEditorLanguage,
} from '@/components/source/source-editor-completions';

function labelsFor(language: SourceEditorLanguage) {
  return sourceEditorCompletionOptions(language).map((completion) => completion.label);
}

function completeLabels(language: SourceEditorLanguage, doc: string, explicit = true) {
  const source = createSourceEditorCompletionSource(language, {
    shader: { uniforms: ['u_time'], samplers: ['s_diffuse'] },
  });
  const result = source(new CompletionContext(EditorState.create({ doc }), doc.length, explicit));
  if (!result || result instanceof Promise) return [];
  return result.options.map((completion) => completion.label);
}

describe('SourceEditor language completion metadata', () => {
  it('includes RmlUi RML elements and data binding attributes', () => {
    expect(rmlElementCompletions.map((completion) => completion.label)).toEqual(
      expect.arrayContaining(['rml', 'body', 'button']),
    );
    expect(rmlAttributeCompletions.map((completion) => completion.label)).toEqual(
      expect.arrayContaining(['data-model', 'data-for', 'data-if', 'data-event-*']),
    );
  });

  it('includes RmlUi RCSS additions', () => {
    expect(rcssCompletions.map((completion) => completion.label)).toEqual(
      expect.arrayContaining(['decorator', 'decorator: shader()', 'filter: blur()']),
    );
  });

  it('includes enabled Lua runtime globals and omits disabled libraries and loaders', () => {
    const labels = luaRuntimeCompletions.map((completion) => completion.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'noveltea',
        'noveltea.random.integer',
        'noveltea.map.activate',
        'noveltea.layouts.set',
        'noveltea.layouts.mount',
        'noveltea.layouts.mounted',
        'noveltea.presentation.set_background',
        'noveltea.presentation.set_actor',
        'noveltea.presentation.set_prop',
        'noveltea.presentation.environment',
        'noveltea.text_log.append',
        'Game.pause',
        'audio.play_and_wait',
        'math.randomseed',
        'print',
        'string',
        'table',
        'math',
        'utf8',
      ]),
    );
    expect(labels).not.toEqual(expect.arrayContaining(['audio.play_sfx', 'audio.play_track']));
    expect(labels).not.toEqual(
      expect.arrayContaining(['os', 'io', 'debug', 'package', 'require', 'dofile', 'loadfile']),
    );
  });

  it('includes bgfx shaderc tokens, helpers, uniforms, and varying attributes', () => {
    expect(shaderCompletions.map((completion) => completion.label)).toEqual(
      expect.arrayContaining([
        '$input',
        '$output',
        '#include "bgfx_shader.sh"',
        'SAMPLER2D',
        'mul',
        'u_modelViewProj',
        'a_position',
        'v_texcoord0',
      ]),
    );
  });

  it('keeps concrete options available through the public option helper', () => {
    expect(labelsFor('rml')).toEqual(expect.arrayContaining(['button', 'data-model']));
    expect(labelsFor('rcss')).toEqual(expect.arrayContaining(['decorator: shader()']));
    expect(labelsFor('lua')).toEqual(expect.arrayContaining(['noveltea.lua_version']));
    expect(labelsFor('shader')).toEqual(expect.arrayContaining(['SAMPLER2D']));
  });
});

describe('SourceEditor completion sources', () => {
  it('returns RML completions for RML documents', () => {
    expect(completeLabels('rml', '<but')).toEqual(expect.arrayContaining(['button', 'data-model']));
  });

  it('returns RCSS completions for RCSS documents', () => {
    expect(completeLabels('rcss', 'decor')).toEqual(
      expect.arrayContaining(['decorator', 'decorator: shader()']),
    );
  });

  it('returns Lua runtime completions for Lua documents', () => {
    expect(completeLabels('lua', 'nov')).toEqual(
      expect.arrayContaining(['noveltea', 'noveltea.lua_version']),
    );
  });

  it('returns shader and project shader interface completions for shader documents', () => {
    expect(completeLabels('shader', '$')).toEqual(
      expect.arrayContaining(['$input', '$output', 'SAMPLER2D', 'u_time', 's_diffuse']),
    );
  });

  it('does not open implicit completion on an empty token', () => {
    expect(completeLabels('lua', '', false)).toEqual([]);
  });
});
