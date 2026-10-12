import { describe, expect, it } from 'vite-plus/test';
import {
  AUTHORING_GRAPH_FIELD_METADATA,
  classifyAuthoringGraphInputPath,
  CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS,
  EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS,
} from '../../shared/project-schema/authoring-graph-field-metadata';
import {
  AUTHORING_GRAPH_FIELD_METADATA as REVIEWED_AUTHORING_GRAPH_FIELD_METADATA,
  classifyAuthoringGraphInputPath as reviewedClassification,
  CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS as REVIEWED_CURRENT_FINGERPRINTS,
  EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS as REVIEWED_EXPECTED_FINGERPRINTS,
} from '../../shared/project-schema/authoring-graph-field-metadata-review';

describe('generated authoring graph field metadata', () => {
  it('preserves wildcard, parent, unknown and escaped-path classification with indexed lookups', () => {
    const paths = new Set(['', '/', '/unknown', '/rooms/unknown/data/unknown', '/editor']);
    AUTHORING_GRAPH_FIELD_METADATA.forEach((field, index) => {
      paths.add(`/${field.schemaRoot}`);
      if (index % 509 !== 0) return;
      const concrete = field.path.replaceAll('*', 'sample~1id~0');
      paths.add(concrete);
      paths.add(concrete.slice(0, concrete.lastIndexOf('/')));
    });
    for (const path of paths) {
      const expected = reviewedClassification(path);
      expect(classifyAuthoringGraphInputPath(path), path).toEqual(expected);
      expect(classifyAuthoringGraphInputPath(path), path).toEqual(expected);
    }
  });
  it('preserves the exact schema-derived paths, effects and order', () => {
    expect(AUTHORING_GRAPH_FIELD_METADATA).toEqual(REVIEWED_AUTHORING_GRAPH_FIELD_METADATA);
    expect(CURRENT_AUTHORING_GRAPH_FIELD_FINGERPRINTS).toEqual(REVIEWED_CURRENT_FINGERPRINTS);
    expect(EXPECTED_AUTHORING_GRAPH_FIELD_FINGERPRINTS).toEqual(REVIEWED_EXPECTED_FINGERPRINTS);
  });
});
