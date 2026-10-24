import { runtimeExportProfileForPlatform } from '../shared/project-schema/authoring-export';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import {
  PLAYER_RUNTIME_API_VERSION,
  type InstalledTemplate,
  type PlatformExportProfile,
} from '../shared/project-schema/platform-export-contracts';
import { COMPILED_PROJECT_FORMAT_VERSION } from '../shared/project-schema/compiled-project';
import { evaluateTemplateCompatibility } from '../shared/project-schema/template-compatibility';
import { derivedPlatformCapabilities } from '../shared/project-schema/platform-deployment';

/** Presentation of native-admitted profiles; does not read or validate Project YAML. */
export async function profileRows(
  project: Pick<AuthoringProject, 'export'>,
  profiles: readonly PlatformExportProfile[],
  templates: readonly InstalledTemplate[],
) {
  const host =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return profiles.map((profile) => {
    const runtimeProfile = runtimeExportProfileForPlatform(
      project,
      profile.target,
      profile.localization,
    );
    const hostCompatible = templates.some(
      (template) =>
        template.status !== 'corrupted' &&
        evaluateTemplateCompatibility(template.descriptor, {
          profile,
          compiledProjectFormatVersion: COMPILED_PROJECT_FORMAT_VERSION,
          playerRuntimeApiVersion: PLAYER_RUNTIME_API_VERSION,
          shaderVariants: runtimeProfile.shaderVariants,
          graphicsBackends: [],
          capabilities: derivedPlatformCapabilities(profile.target),
          requiredFeatures: [],
          host: { platform: host, availableTools: [] },
        }).compatible,
    );
    const artifact =
      profile.target === 'web'
        ? profile.web.artifact
        : profile.target === 'android'
          ? profile.android.artifact
          : profile.desktop.artifact;
    return {
      id: profile.id,
      label: profile.label,
      target: profile.target,
      architecture: profile.architecture,
      buildFlavor: profile.buildFlavor,
      artifact,
      hostCompatible,
    };
  });
}
