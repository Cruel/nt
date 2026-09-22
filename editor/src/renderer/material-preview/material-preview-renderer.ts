import { materialContractRegistry } from '../../shared/project-schema/material-contract-registry.generated';
import type { ShaderUniformValue } from '../../shared/project-schema/authoring-shaders';
import type {
  MaterialPreviewProjectResources,
  MaterialPreviewResource,
} from './material-preview-resources';

export interface MaterialPreviewPointerState {
  x: number;
  y: number;
  pressed: boolean;
}

export interface MaterialPreviewSurfaceState {
  canvas: HTMLCanvasElement;
  materialId: string;
  width: number;
  height: number;
  visible: boolean;
  pointer: MaterialPreviewPointerState;
  resources?: MaterialPreviewProjectResources;
  parameterOverrides?: Readonly<Record<string, ShaderUniformValue>>;
  onShaderProgramStatus?: (status: { stale: boolean; message: string | null }) => void;
}

export interface MaterialPreviewGroupRendererStatus {
  available: boolean;
  code: string | null;
  message: string | null;
}

interface RegisteredSurface {
  state: MaterialPreviewSurfaceState;
  resource: MaterialPreviewResource | null;
  resourceGeneration: number;
}

export interface MaterialPreviewBackend {
  render: (
    surface: MaterialPreviewSurfaceState,
    resource: MaterialPreviewResource,
    timeSeconds: number,
  ) => void;
  invalidateProjectResources: () => void;
  reset: () => void;
  dispose: () => void;
}

export interface MaterialPreviewBackendFactoryOptions {
  onContextLost: () => void;
  onContextRestored: () => void;
}

export type MaterialPreviewBackendFactory = (
  options: MaterialPreviewBackendFactoryOptions,
) => MaterialPreviewBackend | null;

export interface MaterialPreviewScheduler {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
}

const browserScheduler: MaterialPreviewScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (id) => window.cancelAnimationFrame(id),
};

const FALLBACK_VERTEX_SOURCE = `#version 300 es
precision mediump float;
in vec2 a_position;
in vec2 a_texcoord0;
in vec4 a_color0;
out vec2 v_texcoord0;
out vec4 v_color0;
void main() {
  v_texcoord0 = a_texcoord0;
  v_color0 = a_color0;
  gl_Position = vec4(a_position, 0.0, 1.0);
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

function backgroundColor(background: MaterialPreviewResource['resolved']['preview']['background']) {
  if (background === 'light') return [0.88, 0.88, 0.88, 1] as const;
  if (background === 'dark') return [0.08, 0.08, 0.1, 1] as const;
  return [0, 0, 0, 0] as const;
}

function paintCheckerBackground(context: CanvasRenderingContext2D, width: number, height: number) {
  const cell = 8;
  context.fillStyle = 'rgb(52, 52, 57)';
  context.fillRect(0, 0, width, height);
  context.fillStyle = 'rgb(78, 78, 84)';
  for (let y = 0; y < height; y += cell) {
    for (let x = (Math.floor(y / cell) % 2) * cell; x < width; x += cell * 2) {
      context.fillRect(x, y, cell, cell);
    }
  }
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

const identityMatrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function setIdentityTransform(gl: WebGL2RenderingContext, program: WebGLProgram) {
  const location = gl.getUniformLocation(program, 'u_modelViewProj');
  if (location === null) return;
  gl.uniformMatrix4fv(location, false, identityMatrix);
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

export class MaterialPreviewShaderProgramError extends Error {
  constructor(
    readonly stale: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'MaterialPreviewShaderProgramError';
  }
}

class WebGlMaterialPreviewBackend implements MaterialPreviewBackend {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly programCache = new Map<string, WebGLProgram>();
  private readonly programFailureCache = new Map<string, string>();
  private readonly lastGoodProgramByMaterialId = new Map<string, WebGLProgram>();
  private readonly textureCache = new Map<string, WebGLTexture>();
  private readonly geometryCache = new Map<
    MaterialPreviewResource['resolved']['preview']['geometry'],
    {
      positionBuffer: WebGLBuffer;
      texcoordBuffer: WebGLBuffer;
      colorBuffer: WebGLBuffer;
      count: number;
    }
  >();

  constructor(options: MaterialPreviewBackendFactoryOptions) {
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
    this.canvas.addEventListener('webglcontextrestored', () => {
      options.onContextRestored();
    });
  }

  render(
    surface: MaterialPreviewSurfaceState,
    resource: MaterialPreviewResource,
    timeSeconds: number,
  ) {
    const width = Math.max(1, Math.round(surface.width));
    const height = Math.max(1, Math.round(surface.height));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    const clear = backgroundColor(resource.resolved.preview.background);
    gl.clearColor(clear[0], clear[1], clear[2], clear[3]);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const vertexSource = resource.vertexShaderSource ?? FALLBACK_VERTEX_SOURCE;
    const fragmentSource =
      resource.fragmentShaderSource ??
      (resource.resolved.role === 'postprocess'
        ? POSTPROCESS_TINT_FRAGMENT_SOURCE
        : FALLBACK_FRAGMENT_SOURCE);
    const programKey = `${vertexSource}\u0000${fragmentSource}`;
    let program = this.programCache.get(programKey);
    let shaderProgramError: MaterialPreviewShaderProgramError | null = null;
    const cachedFailure = this.programFailureCache.get(programKey);
    if (!program && cachedFailure) {
      const lastGood = this.lastGoodProgramByMaterialId.get(resource.materialId) ?? null;
      if (!lastGood) throw new MaterialPreviewShaderProgramError(false, cachedFailure);
      program = lastGood;
      shaderProgramError = new MaterialPreviewShaderProgramError(true, cachedFailure);
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
        if (!lastGood) throw new MaterialPreviewShaderProgramError(false, message);
        program = lastGood;
        shaderProgramError = new MaterialPreviewShaderProgramError(true, message);
      }
    } else {
      this.lastGoodProgramByMaterialId.set(resource.materialId, program);
    }
    gl.useProgram(program);
    const geometry = this.bindGeometry(program, resource.resolved.preview.geometry);
    setIdentityTransform(gl, program);

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
      const filtering =
        rendererSampler.filterPolicy.length === 1 && rendererSampler.filterPolicy[0] === 'nearest'
          ? 'clamp-nearest'
          : 'clamp-linear';
      const fixtureKey = `__renderer_fixture_${rendererSampler.semantic}__`;
      const premultiplyAlpha = rendererSampler.semantic !== 'engine.draw_texture';
      const representativeTexture = this.textureFor(fixtureKey, null, filtering, premultiplyAlpha);
      if (!representativeTexture) continue;
      gl.activeTexture(gl.TEXTURE0 + rendererSampler.stage);
      gl.bindTexture(gl.TEXTURE_2D, representativeTexture);
      const sampler = gl.getUniformLocation(program, rendererSampler.name);
      if (sampler) gl.uniform1i(sampler, rendererSampler.stage);
    }
    const textureEntries = Object.entries(resource.textures).filter(
      ([name]) => !rendererSamplerNames.has(name),
    );
    for (const [name, textureResource] of textureEntries) {
      const filtering = resource.resolved.textures[name]?.filtering ?? 'clamp-linear';
      const texture = this.textureFor(textureResource.key, textureResource.image, filtering);
      if (!texture) continue;
      gl.activeTexture(gl.TEXTURE0 + textureUnit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const sampler = gl.getUniformLocation(program, name);
      if (sampler) gl.uniform1i(sampler, textureUnit);
      textureUnit += 1;
    }
    for (const [name, parameter] of Object.entries(resource.resolved.parameters)) {
      if (parameter.value !== undefined) setUniformValue(gl, program, name, parameter.value);
    }
    for (const [name, value] of Object.entries(surface.parameterOverrides ?? {}))
      setUniformValue(gl, program, name, value);
    setUniformValue(gl, program, 'u_time', timeSeconds);
    setUniformValue(
      gl,
      program,
      'u_hotspotHovered',
      surface.pointer.x >= 0 && surface.pointer.y >= 0,
    );
    setUniformValue(gl, program, 'u_hotspotPressed', surface.pointer.pressed);
    setUniformValue(gl, program, 'u_hotspotBounds', [0, 0, width, height]);
    setUniformValue(gl, program, 'u_hotspotImageDimensions', [width, height]);
    setUniformValue(gl, program, 'u_hotspotMaskDimensions', [width, height]);

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

    if (surface.canvas.width !== width) surface.canvas.width = width;
    if (surface.canvas.height !== height) surface.canvas.height = height;
    const target = surface.canvas.getContext('2d');
    if (target) {
      target.clearRect(0, 0, width, height);
      if (resource.resolved.preview.background === 'checker') {
        paintCheckerBackground(target, width, height);
      }
      target.drawImage(this.canvas, 0, 0, width, height);
    }
    if (shaderProgramError) throw shaderProgramError;
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

  private bindGeometry(
    program: WebGLProgram,
    geometry: MaterialPreviewResource['resolved']['preview']['geometry'],
  ) {
    const gl = this.gl;
    let cached = this.geometryCache.get(geometry);
    if (!cached) {
      const inset = geometry === 'glyphs' ? 0.22 : geometry === 'rounded-rect' ? 0.08 : 0;
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
      const texcoords = new Float32Array([0, 1, 1, 1, 0, 0, 1, 0]);
      const colors = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      const positionBuffer = gl.createBuffer();
      const texcoordBuffer = gl.createBuffer();
      const colorBuffer = gl.createBuffer();
      if (!positionBuffer || !texcoordBuffer || !colorBuffer)
        throw new Error('Unable to allocate preview geometry.');
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, texcoords, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
      cached = { positionBuffer, texcoordBuffer, colorBuffer, count: 4 };
      this.geometryCache.set(geometry, cached);
    }
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    if (positionLocation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.positionBuffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    }
    const texcoordLocation = gl.getAttribLocation(program, 'a_texcoord0');
    if (texcoordLocation >= 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, cached.texcoordBuffer);
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
    key: string,
    image: TexImageSource | null,
    filtering: MaterialPreviewResource['resolved']['textures'][string]['filtering'],
    premultiplyAlpha = true,
  ) {
    const cacheKey = `${key}:${filtering}:${premultiplyAlpha ? 'premultiplied' : 'straight'}`;
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
    if (image) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        2,
        2,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([
          255, 255, 255, 255, 170, 170, 170, 255, 170, 170, 170, 255, 255, 255, 255, 255,
        ]),
      );
    }
    this.textureCache.set(cacheKey, texture);
    return texture;
  }
}

export const createWebGlMaterialPreviewBackend: MaterialPreviewBackendFactory = (options) => {
  try {
    return new WebGlMaterialPreviewBackend(options);
  } catch {
    return null;
  }
};

export class MaterialPreviewGroupRenderer {
  private readonly surfaces = new Map<object, RegisteredSurface>();
  private readonly listeners = new Set<() => void>();
  private backend: MaterialPreviewBackend | null | undefined;
  private frame: number | null = null;
  private disposed = false;
  private statusValue: MaterialPreviewGroupRendererStatus = {
    available: true,
    code: null,
    message: null,
  };
  private contextLost = false;
  private renderFailed = false;

  constructor(
    private readonly resources: MaterialPreviewProjectResources,
    private readonly backendFactory: MaterialPreviewBackendFactory = createWebGlMaterialPreviewBackend,
    private readonly scheduler: MaterialPreviewScheduler = browserScheduler,
  ) {}

  get status() {
    return this.statusValue;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  registerSurface(state: MaterialPreviewSurfaceState) {
    const token = {};
    this.surfaces.set(token, { state, resource: null, resourceGeneration: -1 });
    this.ensureBackend();
    if (state.visible) void this.refreshSurface(token);
    this.schedule();
    return {
      update: (next: MaterialPreviewSurfaceState) => {
        const registered = this.surfaces.get(token);
        if (!registered) return;
        const previousResources = registered.state.resources ?? this.resources;
        const nextResources = next.resources ?? this.resources;
        const becameVisible = !registered.state.visible && next.visible;
        const resourceChanged =
          registered.state.materialId !== next.materialId ||
          previousResources !== nextResources ||
          registered.resourceGeneration !== nextResources.generation;
        registered.state = next;
        if (resourceChanged) {
          registered.resource = null;
          registered.resourceGeneration = -1;
        }
        if (next.visible && (resourceChanged || becameVisible)) void this.refreshSurface(token);
        this.schedule();
      },
      unregister: () => {
        this.surfaces.delete(token);
        if (this.surfaces.size === 0 && this.frame !== null) {
          this.scheduler.cancel(this.frame);
          this.frame = null;
        }
      },
    };
  }

  invalidateProjectResources() {
    this.backend?.invalidateProjectResources();
    this.renderFailed = false;
    for (const [token, registered] of this.surfaces) {
      registered.resource = null;
      registered.resourceGeneration = -1;
      if (registered.state.visible) void this.refreshSurface(token);
    }
    this.schedule();
  }

  dispose() {
    this.disposed = true;
    if (this.frame !== null) this.scheduler.cancel(this.frame);
    this.frame = null;
    this.surfaces.clear();
    this.listeners.clear();
    this.backend?.dispose();
    this.backend = undefined;
  }

  private async refreshSurface(token: object) {
    const registered = this.surfaces.get(token);
    if (!registered || !registered.state.visible) return;
    const resources = registered.state.resources ?? this.resources;
    const generation = resources.generation;
    const materialId = registered.state.materialId;
    const resource = await resources.getMaterial(materialId);
    const current = this.surfaces.get(token);
    if (
      !current ||
      !current.state.visible ||
      current.state.materialId !== materialId ||
      (current.state.resources ?? this.resources) !== resources ||
      generation !== resources.generation
    )
      return;
    current.resource = resource;
    current.resourceGeneration = generation;
    this.schedule();
  }

  private schedule() {
    if (
      this.disposed ||
      !this.backend ||
      this.contextLost ||
      this.renderFailed ||
      this.frame !== null
    )
      return;
    if (![...this.surfaces.values()].some((surface) => surface.state.visible)) return;
    this.frame = this.scheduler.request((timestamp) => {
      this.frame = null;
      this.renderFrame(timestamp);
      if ([...this.surfaces.values()].some((surface) => surface.state.visible)) this.schedule();
    });
  }

  private renderFrame(timestamp: number) {
    if (!this.backend || this.contextLost) return;
    for (const [token, registered] of this.surfaces) {
      if (!registered.state.visible) continue;
      const resources = registered.state.resources ?? this.resources;
      if (registered.resourceGeneration !== resources.generation) {
        void this.refreshSurface(token);
        continue;
      }
      if (registered.resource) {
        try {
          this.backend.render(registered.state, registered.resource, timestamp / 1000);
          registered.state.onShaderProgramStatus?.({ stale: false, message: null });
        } catch (error) {
          if (error instanceof MaterialPreviewShaderProgramError) {
            registered.state.onShaderProgramStatus?.({
              stale: error.stale,
              message: error.message,
            });
            continue;
          }
          this.renderFailed = true;
          this.setStatus({
            available: false,
            code: 'material-preview.render-failed',
            message: error instanceof Error ? error.message : 'Material preview rendering failed.',
          });
          return;
        }
      }
    }
  }

  private ensureBackend() {
    if (this.backend !== undefined || this.disposed) return;
    this.backend = this.backendFactory({
      onContextLost: () => {
        if (this.disposed) return;
        this.contextLost = true;
        this.setStatus({
          available: false,
          code: 'material-preview.context-lost',
          message: 'Material preview is temporarily unavailable.',
        });
      },
      onContextRestored: () => {
        if (this.disposed) return;
        this.backend?.reset();
        this.contextLost = false;
        this.renderFailed = false;
        this.setStatus({ available: true, code: null, message: null });
        this.schedule();
      },
    });
    if (!this.backend) {
      this.setStatus({
        available: false,
        code: 'material-preview.webgl2-unavailable',
        message: 'Material preview requires WebGL2.',
      });
    }
  }

  private setStatus(status: MaterialPreviewGroupRendererStatus) {
    if (
      this.statusValue.available === status.available &&
      this.statusValue.code === status.code &&
      this.statusValue.message === status.message
    )
      return;
    this.statusValue = status;
    for (const listener of this.listeners) listener();
  }
}
