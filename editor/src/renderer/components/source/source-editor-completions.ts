import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

export type SourceEditorLanguage = 'json' | 'lua' | 'rml' | 'rcss' | 'shader' | 'text';

export interface SourceEditorShaderCompletionContext {
  uniforms?: string[];
  samplers?: string[];
}

export interface SourceEditorCompletionContext {
  shader?: SourceEditorShaderCompletionContext;
  symbols?: Completion[];
}

const rmlSection = { name: 'RmlUi', rank: 20 };
const rcssSection = { name: 'RmlUi RCSS', rank: 20 };
const luaSection = { name: 'NovelTea Lua', rank: 20 };
const shaderSection = { name: 'bgfx shader', rank: 20 };
const projectSection = { name: 'Project', rank: 30 };

export const rmlElementCompletions: Completion[] = [
  'rml',
  'head',
  'body',
  'title',
  'link',
  'script',
  'template',
  'div',
  'p',
  'span',
  'br',
  'img',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'form',
  'label',
  'progress',
  'meter',
  'table',
  'tr',
  'td',
  'th',
].map((label) => ({ label, type: 'type', detail: 'RML element', section: rmlSection }));

export const rmlAttributeCompletions: Completion[] = [
  'id',
  'class',
  'style',
  'src',
  'href',
  'type',
  'name',
  'value',
  'checked',
  'disabled',
  'selected',
  'for',
  'tabindex',
  'autofocus',
  'placeholder',
  'onclick',
  'onmouseover',
  'onmouseout',
  'onmousedown',
  'onmouseup',
  'onkeydown',
  'onkeyup',
  'onsubmit',
  'onchange',
  'data-model',
  'data-for',
  'data-if',
  'data-else',
  'data-event-*',
].map((label) => ({ label, type: 'property', detail: 'RML attribute', section: rmlSection }));

export const rcssCompletions: Completion[] = [
  'decorator',
  'filter',
  'image-color',
  'opacity',
  'pointer-events',
  'tab-index',
  'nav-up',
  'nav-down',
  'nav-left',
  'nav-right',
  'drag',
  'focus',
  'clip',
  'box-shadow',
  'text-shadow',
  'linear-gradient',
  'radial-gradient',
  'decorator: image()',
  'decorator: tiled-image()',
  'decorator: ninepatch()',
  'decorator: shader()',
  'filter: blur()',
  'filter: drop-shadow()',
  'filter: brightness()',
  'filter: contrast()',
  'filter: grayscale()',
  'filter: hue-rotate()',
  'filter: opacity()',
  'filter: sepia()',
].map((label) => ({ label, type: label.includes('(') ? 'function' : 'property', detail: 'RCSS', section: rcssSection }));

export const luaRuntimeCompletions: Completion[] = [
  'noveltea',
  'noveltea.lua_version',
  'noveltea.set_demo_position',
  'noveltea.reset_demo',
  'noveltea.set_running',
  'noveltea.random',
  'noveltea.random.seed',
  'noveltea.random.integer',
  'noveltea.random.number',
  'noveltea.map',
  'noveltea.map.present',
  'noveltea.map.hide',
  'noveltea.map.select',
  'noveltea.map.activate',
  'noveltea.map.state',
  'noveltea.layouts',
  'noveltea.layouts.get',
  'noveltea.layouts.set',
  'noveltea.layouts.clear',
  'noveltea.layouts.mount',
  'noveltea.layouts.unmount',
  'noveltea.layouts.mounted',
  'noveltea.presentation',
  'noveltea.presentation.set_background',
  'noveltea.presentation.clear_background',
  'noveltea.presentation.background',
  'noveltea.presentation.set_actor',
  'noveltea.presentation.clear_actor',
  'noveltea.presentation.actor',
  'noveltea.presentation.set_prop',
  'noveltea.presentation.clear_prop',
  'noveltea.presentation.prop',
  'noveltea.presentation.set_environment',
  'noveltea.presentation.clear_environment',
  'noveltea.presentation.stop_environments',
  'noveltea.presentation.environment',
  'noveltea.text_log',
  'noveltea.text_log.append',
  'noveltea.text_log.clear',
  'Game.pause',
  'Game.resume',
  'Game.paused',
  'audio',
  'audio.play',
  'audio.play_and_wait',
  'audio.stop',
  'audio.stop_and_wait',
  'audio.state',
  'print',
  'assert',
  'error',
  'ipairs',
  'next',
  'pairs',
  'pcall',
  'select',
  'tonumber',
  'tostring',
  'type',
  'xpcall',
  'string',
  'string.byte',
  'string.char',
  'string.find',
  'string.format',
  'string.gmatch',
  'string.gsub',
  'string.len',
  'string.lower',
  'string.match',
  'string.rep',
  'string.reverse',
  'string.sub',
  'string.upper',
  'table',
  'table.concat',
  'table.insert',
  'table.move',
  'table.pack',
  'table.remove',
  'table.sort',
  'table.unpack',
  'math',
  'math.abs',
  'math.ceil',
  'math.floor',
  'math.max',
  'math.min',
  'math.random',
  'math.randomseed',
  'math.sqrt',
  'utf8',
  'utf8.char',
  'utf8.codes',
  'utf8.len',
].map((label) => ({ label, type: label.includes('.') ? 'method' : 'variable', detail: 'Lua runtime', section: luaSection }));

export const shaderCompletions: Completion[] = [
  '$input',
  '$output',
  '#include "bgfx_shader.sh"',
  'SAMPLER2D',
  'SAMPLER2DARRAY',
  'SAMPLER3D',
  'SAMPLERCUBE',
  'mul',
  'splat',
  'splatX',
  'splatY',
  'splatZ',
  'splatW',
  'mtxFromCols',
  'mtxFromRows',
  'mtxProj',
  'mtxLookAt',
  'u_viewRect',
  'u_viewTexel',
  'u_view',
  'u_invView',
  'u_proj',
  'u_invProj',
  'u_viewProj',
  'u_invViewProj',
  'u_model',
  'u_modelView',
  'u_modelViewProj',
  'a_position',
  'a_normal',
  'a_tangent',
  'a_bitangent',
  'a_color0',
  'a_color1',
  'a_indices',
  'a_weight',
  'a_texcoord0',
  'a_texcoord1',
  'a_texcoord2',
  'a_texcoord3',
  'a_texcoord4',
  'a_texcoord5',
  'a_texcoord6',
  'a_texcoord7',
  'v_texcoord0',
  'v_color0',
].map((label) => ({ label, type: label.endsWith(')') ? 'function' : 'keyword', detail: 'bgfx shaderc', section: shaderSection }));

function completionsForLanguage(language: SourceEditorLanguage, context?: SourceEditorCompletionContext): Completion[] {
  const projectSymbols = (context?.symbols ?? []).map((item) => ({ ...item, section: item.section ?? projectSection }));
  if (language === 'rml') return [...rmlElementCompletions, ...rmlAttributeCompletions, ...projectSymbols];
  if (language === 'rcss') return [...rcssCompletions, ...projectSymbols];
  if (language === 'lua') return [...luaRuntimeCompletions, ...projectSymbols];
  if (language !== 'shader') return projectSymbols;

  const shaderSymbols: Completion[] = [
    ...(context?.shader?.uniforms ?? []).map((label) => ({ label, type: 'variable', detail: 'shader uniform', section: projectSection })),
    ...(context?.shader?.samplers ?? []).map((label) => ({ label, type: 'variable', detail: 'shader sampler', section: projectSection })),
  ];
  return [...shaderCompletions, ...shaderSymbols, ...projectSymbols];
}

export function createSourceEditorCompletionSource(language: SourceEditorLanguage, context?: SourceEditorCompletionContext): CompletionSource {
  const options = completionsForLanguage(language, context);
  return (completionContext: CompletionContext): CompletionResult | null => {
    const word = completionContext.matchBefore(/[#"$\w.-]*$/);
    if (!word || (word.from === word.to && !completionContext.explicit)) return null;
    return {
      from: word.from,
      options,
      validFor: /^[#"$\w.-]*$/,
    };
  };
}

export function sourceEditorCompletionOptions(language: SourceEditorLanguage, context?: SourceEditorCompletionContext): Completion[] {
  return completionsForLanguage(language, context);
}
