const utf8 = new TextEncoder();

function hex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

export async function sha256HexBytes(value: Uint8Array): Promise<string> {
  const bytes = Uint8Array.from(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.buffer);
  return hex(new Uint8Array(digest));
}

export async function sha256HexUtf8(value: string): Promise<string> {
  return sha256HexBytes(utf8.encode(value));
}

export async function sha256PrefixedBytes(value: Uint8Array): Promise<`sha256:${string}`> {
  return `sha256:${await sha256HexBytes(value)}`;
}

export async function sha256PrefixedUtf8(value: string): Promise<`sha256:${string}`> {
  return `sha256:${await sha256HexUtf8(value)}`;
}
