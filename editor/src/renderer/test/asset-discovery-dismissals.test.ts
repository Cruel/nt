import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  dismissAssetCandidates,
  undisclosedAssetCandidates,
} from '@/assets/asset-discovery-dismissals';
import type { ProjectAssetAuditFile } from '../../shared/project-asset-audit';

const media = (
  projectRelativePath: string,
  revision: string,
  importable = true,
): ProjectAssetAuditFile => ({
  projectRelativePath,
  revision,
  importable,
  absolutePath: `/project/${projectRelativePath}`,
  extension: '.png',
  kind: 'image',
  byteSize: 100,
  modifiedAt: '2026-10-08T12:00:00Z',
});

beforeEach(() => localStorage.clear());

describe('Asset discovery notification dismissal', () => {
  it('persists only selected file revisions by Project, without hiding them from manual discovery', () => {
    const files = [
      media('assets/images/a.png', '100:1'),
      media('assets/images/b.png', '100:1'),
      media('assets/data/doc.json', '5:1', false),
    ];
    expect(undisclosedAssetCandidates('/project/project.json', files)).toHaveLength(2);
    dismissAssetCandidates('/project/project.json', [files[0]]);
    expect(undisclosedAssetCandidates('/project/project.json', files)).toEqual([files[1]]);
    expect(undisclosedAssetCandidates('/other/project.json', files)).toHaveLength(2);
    expect(
      undisclosedAssetCandidates('/project/project.json', [media('assets/images/a.png', '100:2')]),
    ).toHaveLength(1);
    expect(files).toHaveLength(3);
  });
});
