import { describe, expect, it } from 'vite-plus/test';
import { createAuthoringProject } from '../../shared/project-schema/authoring-project';
import { defaultMaterialData } from '../../shared/project-schema/authoring-materials';
import {
  DebouncedShaderPreviewCompiler,
  discoverShaderSourceMaterialUsages,
  shaderSourceOverlays,
} from '@/shaders/shader-source-preview';
import {
  parseShaderSourceTabState,
  seedShaderSourceTabMaterial,
  shaderSourceTabState,
} from '@/shaders/shader-source-tab-state';
import {
  clearWorkbenchTabStates,
  serializeWorkbenchTabStates,
  setWorkbenchTabState,
} from '@/workbench/workbench-tab-state';

function customMaterial(label: string, fragmentPath: string) {
  return {
    ...defaultMaterialData(label),
    shader: {
      fragment: { kind: 'project' as const, path: fragmentPath },
    },
  };
}

describe('shader source preview discovery', () => {
  it('distinguishes direct entrypoint consumers from transitive include consumers using dirty buffers', () => {
    const project = createAuthoringProject();
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: customMaterial('Panel', 'shaders/panel.fs.sc'),
    };
    project.materials.badge = {
      id: 'badge',
      label: 'Badge',
      data: customMaterial('Badge', 'shaders/badge.fs.sc'),
    };

    const usages = discoverShaderSourceMaterialUsages(project, 'shaders/common/color.sh', {
      'shaders/panel.fs.sc': '#include "common/color.sh"\nvoid main() {}',
      'shaders/badge.fs.sc': '#include "common/other.sh"\nvoid main() {}',
      'shaders/common/other.sh': '#include "color.sh"\n',
      'shaders/common/color.sh': 'vec4 tint(vec4 c) { return c; }',
    });

    expect(usages.direct).toEqual([]);
    expect(usages.transitive.map((usage) => usage.materialId)).toEqual(['badge', 'panel']);
    expect(usages.affectedMaterialIds).toEqual(['badge', 'panel']);
  });

  it('reports a direct consumer separately even when another Material reaches the same source transitively', () => {
    const project = createAuthoringProject();
    project.materials.common = {
      id: 'common',
      label: 'Common',
      data: customMaterial('Common', 'shaders/common/color.sh'),
    };
    project.materials.panel = {
      id: 'panel',
      label: 'Panel',
      data: customMaterial('Panel', 'shaders/panel.fs.sc'),
    };

    const usages = discoverShaderSourceMaterialUsages(project, 'shaders/common/color.sh', {
      'shaders/panel.fs.sc': '#include "common/color.sh"\nvoid main() {}',
      'shaders/common/color.sh': 'void main() {}',
    });

    expect(usages.direct.map((usage) => usage.materialId)).toEqual(['common']);
    expect(usages.transitive.map((usage) => usage.materialId)).toEqual(['panel']);
  });

  it('builds a Project-scoped overlay from every dirty shader buffer, including dirty includes', () => {
    expect(
      shaderSourceOverlays(
        [
          { id: 'shaders/panel.fs.sc', kind: 'shader', text: true },
          { id: 'shaders/common/color.sh', kind: 'shader', text: true },
          { id: 'scripts/main.lua', kind: 'lua', text: true },
        ],
        {
          'shaders/panel.fs.sc': {
            text: 'dirty shader',
            baseText: 'saved shader',
            baseContentHash:
              'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            dirty: true,
            conflict: null,
          },
          'shaders/common/color.sh': {
            text: 'dirty include',
            baseText: 'saved include',
            baseContentHash:
              'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            dirty: true,
            conflict: null,
          },
          'scripts/main.lua': {
            text: 'dirty lua',
            baseText: 'saved lua',
            baseContentHash:
              'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            dirty: true,
            conflict: null,
          },
        },
      ),
    ).toEqual({
      'shaders/panel.fs.sc': 'dirty shader',
      'shaders/common/color.sh': 'dirty include',
    });
  });

  it('debounces rapid preview compilation and resolves superseded generations from the latest run', async () => {
    const compiler = new DebouncedShaderPreviewCompiler<string>(1);
    const first = compiler.run(async () => 'first');
    const second = compiler.run(async () => 'second');

    await expect(first).resolves.toBe('second');
    await expect(second).resolves.toBe('second');
    compiler.dispose();
  });

  it('persists canonical and duplicate source-tab preview sets independently', () => {
    clearWorkbenchTabStates();
    const canonical = 'tab:source-file:shaders/panel.sc';
    const duplicate = `${canonical}:duplicate:test`;
    setWorkbenchTabState(canonical, shaderSourceTabState(['panel']));
    setWorkbenchTabState(duplicate, shaderSourceTabState(['badge']));

    seedShaderSourceTabMaterial(canonical, 'warning');

    const serialized = serializeWorkbenchTabStates([canonical, duplicate]);
    expect(parseShaderSourceTabState(serialized[canonical])?.materialIds).toEqual([
      'warning',
      'panel',
    ]);
    expect(parseShaderSourceTabState(serialized[duplicate])?.materialIds).toEqual(['badge']);
    clearWorkbenchTabStates();
  });
});
