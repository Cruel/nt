import type {
  EditorExportLocalState,
  InstalledTemplate,
  PlatformExportProgressEvent,
  PlatformStageResult,
  ProjectPlatformExportRequest,
  TemplateInstallResult,
} from '../shared/project-schema/platform-export-contracts';

export interface NovelTeaCliPlatformToolService {
  listTemplates(): Promise<InstalledTemplate[]>;
  inspectTemplate(token: string): Promise<InstalledTemplate | null>;
  installTemplate(archivePath: string, force: boolean): Promise<TemplateInstallResult>;
  removeTemplate(token: string): Promise<{ removed: boolean }>;
  exportProject(
    request: ProjectPlatformExportRequest,
    onProgress?: (event: PlatformExportProgressEvent) => void,
  ): Promise<PlatformStageResult>;
  initializeConfig(path: string, force: boolean): Promise<EditorExportLocalState>;
}

export const unavailablePlatformTools: NovelTeaCliPlatformToolService = {
  async listTemplates() {
    throw new Error('Platform tooling is unavailable in this CLI host.');
  },
  async inspectTemplate() {
    throw new Error('Platform tooling is unavailable in this CLI host.');
  },
  async installTemplate() {
    throw new Error('Platform tooling is unavailable in this CLI host.');
  },
  async removeTemplate() {
    throw new Error('Platform tooling is unavailable in this CLI host.');
  },
  async exportProject() {
    throw new Error('Platform tooling is unavailable in this CLI host.');
  },
  async initializeConfig() {
    throw new Error('Platform tooling is unavailable in this CLI host.');
  },
};
