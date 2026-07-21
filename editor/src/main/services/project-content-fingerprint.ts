import { createHash } from 'node:crypto';
import { canonicalProjectContentJson } from '../../shared/project-schema/editor-project-state';

export function projectContentFingerprint(project: unknown): string {
  return createHash('sha256').update(canonicalProjectContentJson(project), 'utf8').digest('hex');
}
