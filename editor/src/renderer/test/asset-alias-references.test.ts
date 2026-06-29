import { describe, expect, it } from 'vitest';
import {
  buildAssetAliasIndex,
  findAssetAliasUsages,
  findAssetRecordByAlias,
  rewriteAssetAliasReferences,
} from '../../shared/project-schema/authoring-asset-references';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';

describe('asset alias references', () => {
  it('indexes explicit alias references only', () => {
    const project = createAuthoringProject();
    project.assets.click = {
      id: 'click',
      label: 'Click',
      tags: [],
      data: { kind: 'audio', source: { type: 'project-file', path: 'assets/audio/click.mp3' }, aliases: ['ui.click'] },
    };
    project.rooms.foyer = {
      id: 'foyer',
      label: 'Foyer',
      tags: [],
      data: {
        sound: { $asset: { alias: 'ui.click' } },
        ordinaryString: 'ui.click',
        nested: [{ $asset: { alias: 'ui.click' } }],
      },
    };
    const index = buildAssetAliasIndex(project);
    expect(findAssetAliasUsages(index, 'ui.click')).toHaveLength(2);
    expect(findAssetRecordByAlias(project, 'ui.click')).toEqual({ entityId: 'click' });
  });

  it('rewrites nested explicit alias references', () => {
    const value = {
      sound: { $asset: { alias: 'ui.click', volume: 0.5 } },
      nested: [{ $asset: { alias: 'ui.click' } }],
    };
    expect(rewriteAssetAliasReferences(value, 'ui.click', 'ui.confirm')).toEqual({
      sound: { $asset: { alias: 'ui.confirm', volume: 0.5 } },
      nested: [{ $asset: { alias: 'ui.confirm' } }],
    });
  });
});
