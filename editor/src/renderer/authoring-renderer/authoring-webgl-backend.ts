import { materialContractRegistry } from '../../shared/project-schema/material-contract-registry.generated';
import type {
  AuthoringWebGlBackend,
  AuthoringWebGlBackendFactory,
  AuthoringWebGlMaterialDraw,
  AuthoringWebGlMaterialResource,
  AuthoringWebGlTextureResource,
} from './authoring-webgl-renderer';

type TextureSampling = 'clamp-nearest' | 'clamp-linear' | 'repeat-nearest' | 'repeat-linear';

const FALLBACK_VERTEX_SOURCE = `#version 300 es
precision mediump float;
in vec2 a_position;
in vec2 a_texcoord0;
in vec4 a_color0;
out vec2 v_texcoord0;
out vec4 v_color0;
uniform mat4 u_modelViewProj;
void main() {
  v_texcoord0 = a_texcoord0;
  v_color0 = a_color0;
  gl_Position = u_modelViewProj * vec4(a_position, 0.0, 1.0);
}`;

const FALLBACK_FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in vec2 v_texcoord0;
in vec4 v_color0;
uniform sampler2D s_texColor;
out vec4 fragColor;
void main() {
  vec4 color = v_color0 * texture(s_texColor, v_texcoord0);
  fragColor = vec4(color.rgb * color.a, color.a);
}`;

const POSTPROCESS_TINT_FRAGMENT_SOURCE = `#version 300 es
precision mediump float;
in vec2 v_texcoord0;
uniform sampler2D s_texColor;
uniform vec4 u_tint;
out vec4 fragColor;
void main() {
  vec4 sampled = texture(s_texColor, v_texcoord0);
  float alpha = sampled.a * u_tint.a;
  fragColor = vec4(sampled.rgb * u_tint.rgb * u_tint.a, alpha);
}`;

const identityMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function combinedTextureSampling(
  address: string,
  filter: string,
  inheritedFilter: 'nearest' | 'linear',
): TextureSampling {
  const resolvedFilter =
    filter === 'inherit' ? inheritedFilter : filter === 'nearest' ? 'nearest' : 'linear';
  return `${address === 'repeat' ? 'repeat' : 'clamp'}-${resolvedFilter}`;
}

function webGl2ShaderSource(source: string) {
  return /^\s*#version\s+300\s+es\b/u.test(source) ? source : `#version 300 es\n${source}`;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  source = webGl2ShaderSource(source);
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to allocate WebGL shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'WebGL shader compilation failed.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    throw new Error('Unable to allocate WebGL program.');
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || 'WebGL program link failed.';
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function uniformType(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): number | null {
  const count = Number(gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) ?? 0);
  for (let index = 0; index < count; index += 1) {
    const info = gl.getActiveUniform(program, index);
    if (info && info.name.replace(/\[0\]$/u, '') === name) return info.type;
  }
  return null;
}

function numericVector(value: unknown): number[] | null {
  if (typeof value === 'boolean') return [value ? 1 : 0];
  if (typeof value === 'number') return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'number')) return value;
  if (value && typeof value === 'object') {
    const color = value as Partial<Record<'r' | 'g' | 'b' | 'a', unknown>>;
    if ([color.r, color.g, color.b, color.a].every((item) => typeof item === 'number'))
      return [color.r, color.g, color.b, color.a] as number[];
  }
  return null;
}

function setUniformValue(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  value: unknown,
) {
  const location = gl.getUniformLocation(program, name);
  if (location === null) return;
  const values = numericVector(value);
  if (!values) return;
  const type = uniformType(gl, program, name);
  const component = (index: number) => values[index] ?? 0;
  if (type === gl.FLOAT_VEC4)
    gl.uniform4fv(location, [component(0), component(1), component(2), component(3)]);
  else if (type === gl.FLOAT_VEC3)
    gl.uniform3fv(location, [component(0), component(1), component(2)]);
  else if (type === gl.FLOAT_VEC2) gl.uniform2fv(location, [component(0), component(1)]);
  else if (type === gl.INT || type === gl.BOOL || type === gl.SAMPLER_2D)
    gl.uniform1i(location, Math.trunc(component(0)));
  else if (type === gl.FLOAT || type === null) gl.uniform1f(location, component(0));
}

function setContractRendererUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  roleContract: (typeof materialContractRegistry.roles)[number] | undefined,
) {
  for (const uniform of roleContract?.reservedInterface.rendererUniforms ?? []) {
    const location = gl.getUniformLocation(program, uniform.name);
    if (location === null) continue;
    switch (uniform.semantic) {
      case 'rmlui.projection':
      case 'rmlui.transform':
        gl.uniformMatrix4fv(location, false, identityMatrix);
        break;
      case 'rmlui.translation':
        gl.uniform4fv(location, [0, 0, 0, 0]);
        break;
    }
  }
}

export class AuthoringWebGlShaderProgramError extends Error {
  constructor(
    readonly stale: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'AuthoringWebGlShaderProgramError';
  }
}

export function resolveAuthoringWebGlProgramSources(resource: AuthoringWebGlMaterialResource) {
  const diagnosticMessage = [
    ...(resource.compileDiagnostics ?? []),
    ...(resource.diagnostics ?? []),
  ]
    .map((diagnostic) => diagnostic.message)
    .filter(Boolean)
    .join('\n');
  if (
    (resource.requiresCompiledVertexShader && !resource.vertexShaderSource) ||
    (resource.requiresCompiledFragmentShader && !resource.fragmentShaderSource) ||
    (resource.requiresCompiledShader &&
      resource.requiresCompiledVertexShader === undefined &&
      resource.requiresCompiledFragmentShader === undefined &&
      !resource.vertexShaderSource &&
      !resource.fragmentShaderSource)
  ) {
    throw new AuthoringWebGlShaderProgramError(
      false,
      diagnosticMessage || 'Material shader compilation produced no usable browser output.',
    );
  }
  return {
    vertexSource: resource.vertexShaderSource ?? FALLBACK_VERTEX_SOURCE,
    fragmentSource:
      resource.fragmentShaderSource ??
      (resource.resolved.role === 'postprocess'
        ? POSTPROCESS_TINT_FRAGMENT_SOURCE
        : FALLBACK_FRAGMENT_SOURCE),
    staleError: resource.stale
      ? new AuthoringWebGlShaderProgramError(
          true,
          diagnosticMessage || 'Material preview is using stale last-good shader output.',
        )
      : null,
  };
}

class WebGlAuthoringBackend implements AuthoringWebGlBackend {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly programCache = new Map<string, WebGLProgram>();
  private readonly programFailureCache = new Map<string, string>();
  private readonly lastGoodProgramByMaterialId = new Map<string, WebGLProgram>();
  private readonly textureCache = new Map<string, WebGLTexture>();
  private readonly geometryCache = new Map<
    string,
    {
      positionBuffer: WebGLBuffer;
      texcoordBuffer: WebGLBuffer;
      colorBuffer: WebGLBuffer;
      count: number;
    }
  >();

  constructor(options: Parameters<AuthoringWebGlBackendFactory>[0]) {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is unavailable.');
    this.gl = gl;
    this.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      options.onContextLost();
    });
    this.canvas.addEventListener('webglcontextrestored', () => options.onContextRestored());
  }

  frame(timeSeconds: number) {
    return {
      timeSeconds,
      beginTarget: (
        width: number,
        height: number,
        clearColor: readonly [number, number, number, number] = [0, 0, 0, 0],
      ) => this.beginTarget(width, height, clearColor),
      drawMaterial: (draw: AuthoringWebGlMaterialDraw) => this.drawMaterial(draw),
      copyTargetToCanvas: (
        canvas: HTMLCanvasElement,
        width: number,
        height: number,
        composition?: 'replace' | 'over',
      ) => this.copyTargetToCanvas(canvas, width, height, composition),
    };
  }

  invalidateProjectResources() {
    for (const texture of this.textureCache.values()) this.gl.deleteTexture(texture);
    this.textureCache.clear();
  }

  reset() {
    for (const program of this.programCache.values()) this.gl.deleteProgram(program);
    for (const texture of this.textureCache.values()) this.gl.deleteTexture(texture);
    for (const geometry of this.geometryCache.values()) {
      this.gl.deleteBuffer(geometry.positionBuffer);
      this.gl.deleteBuffer(geometry.texcoordBuffer);
      this.gl.deleteBuffer(geometry.colorBuffer);
    }
    this.programCache.clear();
    this.programFailureCache.clear();
    this.lastGoodProgramByMaterialId.clear();
    this.textureCache.clear();
    this.geometryCache.clear();
  }

  dispose() {
    this.reset();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  private beginTarget(
    width: number,
    height: number,
    clearColor: readonly [number, number, number, number],
  ) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
    this.gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  private drawMaterial(draw: AuthoringWebGlMaterialDraw) {
    const gl = this.gl;
    const { resource } = draw;
    const { vertexSource, fragmentSource, staleError } =
      resolveAuthoringWebGlProgramSources(resource);
    const programKey = `${vertexSource}\u0000${fragmentSource}`;
    let program = this.programCache.get(programKey);
    let shaderProgramError: AuthoringWebGlShaderProgramError | null = staleError;
    const cachedFailure = this.programFailureCache.get(programKey);
    if (!program && cachedFailure) {
      const lastGood = this.lastGoodProgramByMaterialId.get(resource.materialId) ?? null;
      if (!lastGood) throw new AuthoringWebGlShaderProgramError(false, cachedFailure);
      program = lastGood;
      shaderProgramError = new AuthoringWebGlShaderProgramError(true, cachedFailure);
    } else if (!program) {
      try {
        program = createProgram(gl, vertexSource, fragmentSource);
        this.programCache.set(programKey, program);
        this.programFailureCache.delete(programKey);
        this.lastGoodProgramByMaterialId.set(resource.materialId, program);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'WebGL shader compilation failed.';
        const lastGood = this.lastGoodProgramByMaterialId.get(resource.materialId) ?? null;
        this.programFailureCache.set(programKey, message);
        if (!lastGood) throw new AuthoringWebGlShaderProgramError(false, message);
        program = lastGood;
        shaderProgramError = new AuthoringWebGlShaderProgramError(true, message);
      }
    } else {
      this.lastGoodProgramByMaterialId.set(resource.materialId, program);
    }

    gl.useProgram(program);
    const geometry = this.bindGeometry(program, draw.geometry);
    const transformLocation = gl.getUniformLocation(program, 'u_modelViewProj');
    if (transformLocation !== null)
      gl.uniformMatrix4fv(transformLocation, false, draw.modelViewProjection ?? identityMatrix);

    const roleContract = materialContractRegistry.roles.find(
      (role) => role.id === resource.resolved.role,
    );
    setContractRendererUniforms(gl, program, roleContract);

    const rendererSamplers =
      roleContract?.reservedInterface.samplers.filter(
        (sampler) => sampler.sourceOwnership === 'renderer',
      ) ?? [];
    const rendererSamplerNames = new Set(rendererSamplers.map((sampler) => sampler.name));
    let textureUnit = rendererSamplers.reduce(
      (next, sampler) => Math.max(next, sampler.stage + 1),
      0,
    );
    for (const rendererSampler of rendererSamplers) {
      const textureResource = draw.rendererTextures?.[rendererSampler.name];
      if (!textureResource) continue;
      const policy = resource.resolved.textures[rendererSampler.name];
      const filtering = combinedTextureSampling(
        policy?.address ?? rendererSampler.addressPolicy[0] ?? 'clamp',
        policy?.filter ?? rendererSampler.filterPolicy[0] ?? 'linear',
        textureResource.sampling,
      );
      const premultiplyAlpha = rendererSampler.semantic !== 'engine.draw_texture';
      const texture = this.textureFor(textureResource, filtering, premultiplyAlpha);
      if (!texture) continue;
      gl.activeTexture(gl.TEXTURE0 + rendererSampler.stage);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const sampler = gl.getUniformLocation(program, rendererSampler.name);
      if (sampler) gl.uniform1i(sampler, rendererSampler.stage);
    }

    const textureEntries = Object.entries({
      ...resource.textures,
      ...draw.textureOverrides,
    }).filter(([name]) => !rendererSamplerNames.has(name));
    for (const [name, textureResource] of textureEntries) {
      const policy = resource.resolved.textures[name];
      const filtering = combinedTextureSampling(
        policy?.address ?? 'clamp',
        policy?.filter ?? 'linear',
        textureResource.sampling,
      );
      const texture = this.textureFor(textureResource, filtering, true);
      if (!texture) continue;
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const sampler = gl.getUniformLocation(program, name);
      if (sampler) gl.uniform1i(sampler, textureUnit);
      textureUnit += 1;
    }

    for (const [name, parameter] of Object.entries(resource.resolved.parameters)) {
      if (parameter.value !== undefined) setUniformValue(gl, program, name, parameter.value);
      if (
        parameter.binding &&
        draw.semanticInputs &&
        Object.prototype.hasOwnProperty.call(draw.semanticInputs, parameter.binding)
      )
        setUniformValue(gl, program, name, draw.semanticInputs[parameter.binding]);
    }
    for (const [name, value] of Object.entries(draw.parameterOverrides ?? {}))
      setUniformValue(gl, program, name, value);
    for (const [name, value] of Object.entries(draw.uniformOverrides ?? {}))
      setUniformValue(gl, program, name, value);

    if (!roleContract || roleContract.pipelineState.outputAlpha !== 'premultiplied')
      throw new Error('Material contract has an unsupported output alpha convention.');
    if (roleContract.pipelineState.blend === 'premultiplied-alpha') {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    } else if (roleContract.pipelineState.blend === 'replace') {
      gl.disable(gl.BLEND);
    } else {
      throw new Error('Material contract has an unsupported pipeline state.');
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, geometry.count);
    if (shaderProgramError) throw shaderProgramError;
  }

  private copyTargetToCanvas(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    composition: 'replace' | 'over' = 'replace',
  ) {
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const target = canvas.getContext('2d');
    if (!target) return;
    const previousComposition = target.globalCompositeOperation;
    target.globalCompositeOperation = composition === 'over' ? 'source-over' : 'copy';
    target.drawImage(this.canvas, 0, 0, width, height);
    target.globalCompositeOperation = previousComposition;
  }

  private bindGeometry(program: WebGLProgram, geometry: AuthoringWebGlMaterialDraw['geometry']) {
    const gl = this.gl;
    const inset = Math.max(0, geometry.inset ?? 0);
    const uv = geometry.uv ?? { x: 0, y: 0, width: 1, height: 1 };
    const color = geometry.color ?? ([1, 1, 1, 1] as const);
    const geometryKey = `${geometry.kind}:${inset}:${color.join(',')}`;
    let cached = this.geometryCache.get(geometryKey);
    if (!cached) {
      const positions = new Float32Array([
        -1 + inset,
        -1 + inset,
        1 - inset,
        -1 + inset,
        -1 + inset,
        1 - inset,
        1 - inset,
        1 - inset,
      ]);
      const colors = new Float32Array([...color, ...color, ...color, ...color]);
      const positionBuffer = gl.createBuffer();
      const texcoordBuffer = gl.createBuffer();
      const colorBuffer = gl.createBuffer();
      if (!positionBuffer || !texcoordBuffer || !colorBuffer)
        throw new Error('Unable to allocate authoring geometry.');
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, 8 * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      cached = { positionBuffer, texcoordBuffer, colorBuffer, count: 4 };
      this.geometryCache.set(geometryKey, cached);
    }
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    if (positionLocation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    }
    const texcoordLocation = gl.getAttribLocation(program, 'a_texcoord0');
    if (texcoordLocation >= 0) {
      const texcoords = new Float32Array([
        uv.x,
        uv.y + uv.height,
        uv.x + uv.width,
        uv.y + uv.height,
        uv.x,
        uv.y,
        uv.x + uv.width,
        uv.y,
      ]);
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.texcoordBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, texcoords);
      gl.enableVertexAttribArray(texcoordLocation);
      gl.vertexAttribPointer(texcoordLocation, 2, gl.FLOAT, false, 0, 0);
    }
    const colorLocation = gl.getAttribLocation(program, 'a_color0');
    if (colorLocation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.colorBuffer);
      gl.enableVertexAttribArray(colorLocation);
      gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
    }
    return cached;
  }

  private textureFor(
    resource: AuthoringWebGlTextureResource,
    filtering: TextureSampling,
    premultiplyAlpha: boolean,
  ) {
    const fallbackKey = resource.fallbackColor?.join(',') ?? 'checker';
    const cacheKey = `${resource.key}:${filtering}:${premultiplyAlpha ? 'premultiplied' : 'straight'}:${fallbackKey}`;
    const existing = this.textureCache.get(cacheKey);
    if (existing) return existing;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const nearest = filtering.endsWith('-nearest');
    const repeat = filtering.startsWith('repeat-');
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiplyAlpha);
    if (resource.image) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, resource.image);
    } else {
      const fallback = resource.fallbackColor
        ? resource.fallbackColor.map((channel) =>
            Math.round(Math.max(0, Math.min(1, channel)) * 255),
          )
        : null;
      const pixels = fallback
        ? new Uint8Array([...fallback, ...fallback, ...fallback, ...fallback])
        : new Uint8Array([
            255, 255, 255, 255, 170, 170, 170, 255, 170, 170, 170, 255, 255, 255, 255, 255,
          ]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 2, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
    this.textureCache.set(cacheKey, texture);
    return texture;
  }
}

export const createWebGlAuthoringBackend: AuthoringWebGlBackendFactory = (options) => {
  try {
    return new WebGlAuthoringBackend(options);
  } catch {
    return null;
  }
};
