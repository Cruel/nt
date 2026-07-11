import { afterEach, describe, expect, it } from 'vitest';
import { resolveSigningSecret } from '../../main/services/export-signing-service';

describe('export signing secret resolution', () => {
  const name = 'NOVELTEA_TEST_SIGNING_SECRET';
  const previous = process.env[name];

  afterEach(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  it('reads CI secrets only through an explicit environment reference', () => {
    process.env[name] = 'not-persisted';
    expect(resolveSigningSecret(`env:${name}`, 'Keystore password')).toBe('not-persisted');
    expect(() => resolveSigningSecret('plain-text-password', 'Keystore password')).toThrow(/environment secret reference/);
    expect(() => resolveSigningSecret('env:NOVELTEA_MISSING_SECRET', 'Keystore password')).toThrow(/not available/);
  });
});
