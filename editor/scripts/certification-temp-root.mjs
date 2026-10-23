import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// The broker appends /daemon-<32 hex digits>.sock to its runtime root.
// macOS only accepts short sockaddr_un paths. The runner's os.tmpdir() can
// already exceed that limit before the broker appends its socket filename.
export function certificationRootPrefix(label, platform = process.platform, tmpdir = os.tmpdir()) {
  return platform === 'darwin' ? '/tmp/nt-c-' : path.join(tmpdir, label);
}

export async function createCertificationRoot(label) {
  return mkdtemp(certificationRootPrefix(label));
}
