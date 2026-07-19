import { PackageExportDialog } from '@/export/PackageExportDialog';
import { useProjectStore } from '@/project/project-store';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { useWorkbenchStore } from '@/workbench/workbench-store';

export function PlatformExportEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const projectRoot = useProjectStore((state) => state.projectPath);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const project = isAuthoringProject(document) ? document : null;
  const closeTab = useWorkbenchStore((state) => state.closeTab);
  const groupId = useWorkbenchStore(
    (state) =>
      Object.values(state.groupsById).find((group) => group.tabIds.includes(tab.id))?.id ?? null,
  );

  return (
    <PackageExportDialog
      embedded
      initialMode="platform"
      open
      onOpenChange={(open) => {
        if (!open && groupId) closeTab(groupId, tab.id);
      }}
      project={project}
      projectRoot={projectRoot}
      projectFilePath={projectFilePath}
    />
  );
}

export function PlatformExportProfilesEditor({ tab }: WorkbenchEditorProps) {
  const document = useProjectStore((state) => state.document);
  const projectRoot = useProjectStore((state) => state.projectPath);
  const projectFilePath = useProjectStore((state) => state.projectFilePath);
  const project = isAuthoringProject(document) ? document : null;
  const closeTab = useWorkbenchStore((state) => state.closeTab);
  const groupId = useWorkbenchStore(
    (state) =>
      Object.values(state.groupsById).find((group) => group.tabIds.includes(tab.id))?.id ?? null,
  );

  return (
    <PackageExportDialog
      embedded
      profileManagementOnly
      initialMode="platform"
      open
      onOpenChange={(open) => {
        if (!open && groupId) closeTab(groupId, tab.id);
      }}
      project={project}
      projectRoot={projectRoot}
      projectFilePath={projectFilePath}
    />
  );
}
