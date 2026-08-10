declare function noveltea_tooling_compile_shaders_json(
  request: Uint8Array,
  response: Uint8Array,
): number;
declare function noveltea_tooling_run_headless_test_json(
  request: Uint8Array,
  response: Uint8Array,
): number;
declare function noveltea_tooling_run_ui_test_json(
  request: Uint8Array,
  response: Uint8Array,
): number;
declare function noveltea_tooling_export_package_json(
  request: Uint8Array,
  response: Uint8Array,
): number;
declare function noveltea_tooling_shaderc_json(request: Uint8Array, response: Uint8Array): number;

function stableJsonStringify(value: unknown, arrayElement = false): string | undefined {
  if (value === undefined) return arrayElement ? 'null' : undefined;
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? String(Object.is(value, -0) ? 0 : value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) items.push(stableJsonStringify(item, true) ?? 'null');
    return `[${items.join(',')}]`;
  }
  if (typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const properties: string[] = [];
  for (const key of Object.keys(source).sort()) {
    const nested = stableJsonStringify(source[key]);
    if (nested !== undefined) properties.push(`${JSON.stringify(key)}:${nested}`);
  }
  return `{${properties.join(',')}}`;
}

function requestBytes(request: unknown): Uint8Array {
  // Perry 0.5.1220 can lose leading properties from nested object graphs when
  // JSON.stringify is used directly in the full CLI native-call shape.
  const serialized = stableJsonStringify(request);
  if (serialized === undefined) throw new Error('Native tooling request is not JSON serializable.');
  return new TextEncoder().encode(serialized);
}

const structuredResponseCapacity = 16 * 1024 * 1024;

function decodeJsonResponse<T>(written: number, response: Uint8Array): T {
  if (!Number.isSafeInteger(written) || written < 0 || written > response.length)
    throw new Error(
      `Native tooling response requires '${written}' bytes; caller capacity is ${response.length}.`,
    );
  return JSON.parse(new TextDecoder().decode(response.subarray(0, written))) as T;
}

export function compileShadersNative<T>(request: unknown): T {
  const bytes = requestBytes(request);
  const response = new Uint8Array(structuredResponseCapacity);
  return decodeJsonResponse<T>(noveltea_tooling_compile_shaders_json(bytes, response), response);
}

export function runHeadlessTestNative<T>(request: unknown): T {
  const bytes = requestBytes(request);
  const response = new Uint8Array(structuredResponseCapacity);
  return decodeJsonResponse<T>(noveltea_tooling_run_headless_test_json(bytes, response), response);
}

export function runUiTestNative<T>(request: unknown): T {
  const bytes = requestBytes(request);
  const response = new Uint8Array(structuredResponseCapacity);
  return decodeJsonResponse<T>(noveltea_tooling_run_ui_test_json(bytes, response), response);
}

export function exportPackageNative<T>(request: unknown): T {
  const bytes = requestBytes(request);
  const response = new Uint8Array(structuredResponseCapacity);
  return decodeJsonResponse<T>(noveltea_tooling_export_package_json(bytes, response), response);
}

export function shadercNative(arguments_: readonly string[]): number {
  const request = new TextEncoder().encode(JSON.stringify(arguments_));
  const response = new Uint8Array(32);
  const written = noveltea_tooling_shaderc_json(request, response);
  if (!Number.isSafeInteger(written) || written <= 0 || written > response.length)
    throw new Error(`Native shaderc returned invalid response size '${written}'.`);
  const parsed = JSON.parse(new TextDecoder().decode(response.subarray(0, written))) as {
    exitCode?: unknown;
  };
  if (!Number.isSafeInteger(parsed.exitCode) || (parsed.exitCode as number) < 0)
    throw new Error(`Native shaderc returned invalid exit code '${String(parsed.exitCode)}'.`);
  return parsed.exitCode as number;
}
