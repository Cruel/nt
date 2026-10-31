import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { verifyNativeSourceBytes } from '../../main/services/native-authoring-source-proof';

describe('native authoring source proof algorithms', () => {
  const bytes = Buffer.from('abc');
  const changed = Buffer.from('abd');
  const xxh = 'xxh3-128:06b05ab6733a618578af5f94892f3950';
  const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const native = (source: Uint8Array) =>
    Buffer.from(source).equals(bytes) ? xxh : 'xxh3-128:' + '0'.repeat(32);

  it('verifies new XXH3-128 identities and rejects stale and malformed source revisions', () => {
    expect(() =>
      verifyNativeSourceBytes('scripts/one.lua', xxh, bytes, new Map(), native),
    ).not.toThrow();
    expect(() =>
      verifyNativeSourceBytes('scripts/one.lua', xxh, changed, new Map(), native),
    ).toThrow('changed since admission');
    expect(() => verifyNativeSourceBytes('scripts/one.lua', xxh, bytes, new Map())).toThrow(
      'changed since admission',
    );
    expect(() =>
      verifyNativeSourceBytes('scripts/one.lua', 'xxh3-128:INVALID', bytes, new Map(), native),
    ).toThrow('changed since admission');
  });

  it('preserves SHA-256 for legacy source baselines and Asset content integrity', () => {
    expect(() =>
      verifyNativeSourceBytes('scripts/one.lua', sha, bytes, new Map(), native),
    ).not.toThrow();
    expect(() =>
      verifyNativeSourceBytes('scripts/one.lua', sha, changed, new Map(), native),
    ).toThrow('changed since admission');
    expect(() =>
      verifyNativeSourceBytes(
        'assets/one.png',
        'physical:3:100',
        bytes,
        new Map([['assets/one.png', sha]]),
        native,
      ),
    ).not.toThrow();
    expect(() =>
      verifyNativeSourceBytes(
        'assets/one.png',
        'physical:3:100',
        changed,
        new Map([['assets/one.png', sha]]),
        native,
      ),
    ).toThrow('does not match admitted Project');
  });
});
