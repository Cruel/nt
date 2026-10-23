import type { ParsedGlobalArguments } from './bootstrap';
import { novelTeaCliUsageFailure } from './bootstrap';
import {
  cliDiagnostic,
  formatCliResult,
  NOVELTEA_CLI_EXIT_CODES,
  type NovelTeaCliCommandResult,
} from './contracts';
import { nativeProjectRoot, type NativeProjectCommandCall } from './native-project-lifecycle-cli';
import { nativeProjectDiagnostics } from './native-project-results';
import path from 'node:path';
import type { AuthoringProject } from '../shared/project-schema/authoring-project';
import { authoringCollectionKeys } from '../shared/project-schema/authoring-collections';
import { parseAssetData, isSafeProjectAssetPath } from '../shared/project-schema/authoring-assets';
import { buildShaderMaterialProject } from '../shared/project-schema/shader-material-project';
import { localizationFontCoverageLocales } from '../shared/localization-font-coverage';
import { collectRuntimeDistributionNotices } from '../shared/runtime-distribution-notices';
import { nodeRuntimeArtifactPaths } from '../main/services/node-runtime-artifact-adapters';
import { createNodeProjectWorkspaceFileSystem } from '../shared/project-workspace/node-project-workspace-file-system';
import type { ProjectWorkspaceFileSystem } from '../shared/project-workspace/project-workspace-file-system';
import { assertProjectWorkspacePathContained } from '../shared/project-workspace/project-workspace-file-system';
import { projectSettingsFromProject } from '../shared/project-schema/authoring-project-settings';
import type { NovelTeaCliNativeToolService } from './native-tool-service';
import {
  activeFontRevisions,
  compileWithVerifiedValidationCache,
  publishValidationStageCache,
  readValidationStageCache,
} from './validation-stage-cache';
import { sha256HexUtf8 } from '../shared/web-crypto';

/** Static native Project diagnostics, without the downstream validation stages. */
export async function readNativeProjectValidation(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'validate') return null;
  if (globals.command.length !== 1)
    return novelTeaCliUsageFailure('validate does not accept arguments.', globals.json);
  const projectRoot = await nativeProjectRoot(cwd, globals.project);
  if (!projectRoot) {
    const message = 'No NovelTea project.yaml was found from the current directory upward.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.workspace,
        diagnostics: [cliDiagnostic('WORKSPACE_NOT_FOUND', '/project.yaml', message)],
      },
      globals.json,
      { failure: message },
    );
  }
  let response: Awaited<ReturnType<NativeProjectCommandCall>>;
  try {
    response = await native({ action: 'project-validate', projectRoot });
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return formatNativeValidation(response, projectRoot, globals);
}

function formatNativeValidation(
  response: Awaited<ReturnType<NativeProjectCommandCall>>,
  projectRoot: string,
  globals: ParsedGlobalArguments,
): NovelTeaCliCommandResult {
  if (
    response.ok !== true ||
    typeof response.valid !== 'boolean' ||
    !Array.isArray(response.cliDiagnostics)
  ) {
    const message = response.error ?? 'Native Project validation returned an invalid response.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
        diagnostics: [cliDiagnostic('NATIVE_PROJECT_VALIDATION_UNAVAILABLE', '/', message)],
        projectRoot,
      },
      globals.json,
      { failure: message },
    );
  }
  const diagnostics = nativeProjectDiagnostics(response);
  if (
    diagnostics.length !== response.cliDiagnostics.length ||
    (response.valid === false && !diagnostics.some((item) => item.severity === 'error'))
  ) {
    const message = 'Native Project validation returned malformed diagnostics.';
    return formatCliResult(
      {
        success: false,
        exitCode: NOVELTEA_CLI_EXIT_CODES.internal,
        diagnostics: [cliDiagnostic('NATIVE_PROJECT_VALIDATION_UNAVAILABLE', '/', message)],
        projectRoot,
      },
      globals.json,
      { failure: message },
    );
  }
  const success =
    response.valid && !diagnostics.some((diagnostic) => diagnostic.severity === 'error');
  const workspaceFailure = diagnostics.some((item) => item.code.startsWith('WORKSPACE_'));
  return formatCliResult(
    {
      success,
      exitCode: success
        ? NOVELTEA_CLI_EXIT_CODES.success
        : workspaceFailure
          ? NOVELTEA_CLI_EXIT_CODES.workspace
          : NOVELTEA_CLI_EXIT_CODES.semantic,
      diagnostics,
      projectRoot,
    },
    globals.json,
    { success: 'NovelTea validate succeeded.', failure: 'NovelTea validate failed.' },
  );
}

/** The opt-in, native-admitted full public validate pipeline. Static Project
 * authority belongs to the C++ owner. These are only downstream native-tool
 * and physical publication checks; no TypeScript workspace/project reader is
 * constructed here, and failure never retries through that reader.
 */
export async function runNativeProjectValidationCli(
  globals: ParsedGlobalArguments,
  cwd: string,
  native: NativeProjectCommandCall,
  nativeTools: NovelTeaCliNativeToolService,
  fileSystem: ProjectWorkspaceFileSystem = createNodeProjectWorkspaceFileSystem(),
): Promise<NovelTeaCliCommandResult | null> {
  if (globals.command[0] !== 'validate') return null;
  if (globals.command.length !== 1)
    return novelTeaCliUsageFailure('validate does not accept arguments.', globals.json);
  const projectRoot = await nativeProjectRoot(cwd, globals.project);
  if (!projectRoot) return readNativeProjectValidation(globals, cwd, native);

  const fail = (code: string, message: string, exitCode: 3 | 4 | 5 | 6 | 70) =>
    formatCliResult(
      {
        success: false,
        exitCode,
        diagnostics: [cliDiagnostic(code, '/', message)],
        projectRoot,
      },
      globals.json,
      { failure: message },
    );
  try {
    // Validate first, including malformed cold disk sources. An invalid graph
    // cannot be admitted into mutable ProjectSession preparation.
    if (process.env.NOVELTEA_CLI_TRACE === '1')
      process.stderr.write('[native-validation-cli] invoking native project-validate\n');
    const checked = await native({ action: 'project-validate', projectRoot });
    if (process.env.NOVELTEA_CLI_TRACE === '1')
      process.stderr.write('[native-validation-cli] native project-validate returned\n');
    const checkedResult = formatNativeValidation(checked, projectRoot, globals);
    if (!checkedResult.envelope.success || checkedResult.exitCode !== 0) return checkedResult;
    if (typeof checked.sourceGeneration !== 'string' || !checked.sourceGeneration)
      return fail(
        'NATIVE_PROJECT_VALIDATION_UNAVAILABLE',
        'Native validation omitted generation authority.',
        70,
      );

    const prepared = await native({ action: 'shader-preparation', projectRoot });
    if (!prepared.ok) {
      const conflict = prepared.kind === 'conflict';
      return fail(
        conflict ? 'WORKSPACE_REVISION_CONFLICT' : 'WORKSPACE_SOURCE_READ',
        prepared.error ?? 'Native Project preparation failed.',
        conflict ? 5 : 4,
      );
    }
    if (prepared.sourceGeneration !== checked.sourceGeneration)
      return fail(
        'WORKSPACE_REVISION_CONFLICT',
        'Project sources changed between validation and native preparation.',
        5,
      );
    if (
      !prepared.project ||
      typeof prepared.project !== 'object' ||
      Array.isArray(prepared.project) ||
      !prepared.sourceOverlays ||
      typeof prepared.sourceOverlays !== 'object' ||
      Array.isArray(prepared.sourceOverlays) ||
      Object.values(prepared.sourceOverlays).some((text) => typeof text !== 'string')
    )
      return fail(
        'NATIVE_PROJECT_VALIDATION_UNAVAILABLE',
        'Native preparation returned malformed inputs.',
        70,
      );

    const project = { ...prepared.project } as AuthoringProject;
    for (const family of authoringCollectionKeys) if (!(family in project)) project[family] = {};
    const diagnostics = [...nativeProjectDiagnostics(checked)];

    // Physical Assets are not YAML fragments. They must remain available even
    // when no downstream compiler stage happens to reference them.
    const assets = new Map<string, string[]>();
    for (const [id, record] of Object.entries(project.assets)) {
      const asset = parseAssetData(record.data);
      if (!asset || !isSafeProjectAssetPath(asset.source.path)) continue;
      const ids = assets.get(asset.source.path) ?? [];
      ids.push(id);
      assets.set(asset.source.path, ids);
    }
    const physicalRevisions = new Map<string, string>();
    const unavailableAssetKinds = new Map<string, string>();
    for (const [relative, ids] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
      const absolute = fileSystem.joinPath(projectRoot, relative);
      try {
        await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
        const revision = await fileSystem.readFileRevision(absolute);
        physicalRevisions.set(relative, `${revision.contentHash}:${revision.byteSize}`);
      } catch {
        // An absent source becoming available during a long validation must
        // also invalidate the result; it cannot publish a stale missing-file
        // error just because no initial hash was available to compare.
        const metadata = await fileSystem.readPathMetadata?.(absolute).catch(() => null);
        unavailableAssetKinds.set(relative, metadata?.kind ?? 'missing');
        for (const id of ids)
          diagnostics.push(
            cliDiagnostic(
              'authoring.asset.source_unavailable',
              `/assets/${id.replaceAll('~', '~0').replaceAll('/', '~1')}/data/source/path`,
              `Asset '${id}' source '${relative}' is missing or not a regular file.`,
            ),
          );
      }
    }

    // Notices are physical authoring inputs too, even when they are not
    // registered Assets. Bind their complete text to the checked interval.
    const noticePaths = new Set(
      projectSettingsFromProject(project).distributionNotices.map((notice) => notice.path),
    );
    for (const record of Object.values(project.assets)) {
      for (const attachment of parseAssetData(record.data)?.attachments ?? [])
        if (attachment.purpose === 'distribution-notice') noticePaths.add(attachment.path);
    }
    for (const relative of noticePaths) {
      try {
        const absolute = fileSystem.joinPath(projectRoot, relative);
        await assertProjectWorkspacePathContained(fileSystem, projectRoot, absolute);
        const revision = await fileSystem.readFileRevision(absolute);
        physicalRevisions.set(relative, `${revision.contentHash}:${revision.byteSize}`);
      } catch {
        // The notice validator below supplies the actionable diagnostic.
      }
    }

    try {
      await collectRuntimeDistributionNotices(
        project,
        new Set(Object.keys(project.assets)),
        projectRoot,
        nodeRuntimeArtifactPaths,
      );
    } catch (error) {
      diagnostics.push(
        cliDiagnostic(
          'authoring.distribution-notice.invalid',
          '/settings/distributionNotices',
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const stageCache = nativeTools.validationCacheIdentity
      ? await readValidationStageCache(fileSystem, projectRoot, nativeTools.validationCacheIdentity)
      : null;
    let cacheChanged = false;
    if (!nativeTools.validateFontCoverage && Object.keys(project.localization.locales).length > 0)
      diagnostics.push(
        cliDiagnostic(
          'native.localization.font_coverage',
          '/localization',
          'Native font coverage tooling is unavailable.',
        ),
      );
    if (
      nativeTools.validateFontCoverage &&
      !diagnostics.some((item) => item.severity === 'error')
    ) {
      try {
        const locales = localizationFontCoverageLocales(project);
        const revisions = await activeFontRevisions(fileSystem, { projectRoot, project });
        const fingerprint = await sha256HexUtf8(
          JSON.stringify(
            locales.map((locale) => [
              locale.locale,
              locale.supported,
              locale.fonts,
              locale.fingerprint,
            ]),
          ),
        );
        const cachedFont = stageCache?.font;
        const response =
          revisions !== null &&
          cachedFont?.fontRevisions === revisions &&
          cachedFont.localeFingerprint === fingerprint &&
          cachedFont.response.ok &&
          cachedFont.response.success
            ? cachedFont.response
            : await nativeTools.validateFontCoverage({ projectRoot, locales });
        if (
          stageCache &&
          revisions !== null &&
          response.ok &&
          response.success &&
          (cachedFont?.fontRevisions !== revisions || cachedFont.localeFingerprint !== fingerprint)
        ) {
          stageCache.font = {
            dependencyRevision: checked.sourceGeneration,
            fontRevisions: revisions,
            localeFingerprint: fingerprint,
            response,
          };
          cacheChanged = true;
        }
        diagnostics.push(
          ...response.diagnostics.map((item) =>
            cliDiagnostic(
              item.code,
              item.path,
              `${item.message} Message: ${item.messageId}. Effective stack: ${item.fontStack.join(', ')}.`,
              item.severity,
            ),
          ),
        );
        if (!response.ok || !response.success)
          diagnostics.push(
            cliDiagnostic(
              'native.localization.font_coverage',
              '/localization',
              response.error ?? 'Font coverage validation failed.',
            ),
          );
      } catch (error) {
        diagnostics.push(
          cliDiagnostic(
            'native.localization.font_coverage',
            '/localization',
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    }

    if (
      Object.keys(project.materials).length &&
      !diagnostics.some((item) => item.severity === 'error')
    ) {
      const material = await buildShaderMaterialProject(project, [], {
        certifyPresetPrograms: true,
      });
      diagnostics.push(
        ...material.diagnostics.map((item) =>
          cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
        ),
      );
      if (!diagnostics.some((item) => item.severity === 'error')) {
        try {
          const options = {
            projectRoot,
            outputRoot: path.join(projectRoot, '.noveltea', 'build'),
            cacheRoot: path.join(projectRoot, '.noveltea', 'cache'),
            shaderVariants: ['glsl-330', 'essl-300', 'metal'],
            sourceOverlays: prepared.sourceOverlays as Record<string, string>,
          };
          const response = await compileWithVerifiedValidationCache(
            fileSystem,
            projectRoot,
            nativeTools.validationCacheIdentity,
            material.compilation,
            options,
            () => nativeTools.compileShaders(material.compilation, options),
            stageCache ? { cache: stageCache } : undefined,
          );
          diagnostics.push(
            ...(response.diagnostics ?? []).map((item) =>
              cliDiagnostic(
                `native.shader.${item.code ?? 'compile'}`,
                item.path ?? item.sourcePath ?? item.outputPath ?? '/materials',
                item.message,
                item.severity,
              ),
            ),
          );
          if (response.ok && response.success) {
            const reflected = await buildShaderMaterialProject(project, response.outputs ?? []);
            diagnostics.push(
              ...reflected.diagnostics.map((item) =>
                cliDiagnostic('shader.material_project', item.path, item.message, item.severity),
              ),
            );
          } else if (!response.diagnostics?.some((item) => item.severity === 'error'))
            diagnostics.push(
              cliDiagnostic(
                'native.shader.compile',
                '/shaders',
                response.error ?? 'Shader compilation failed.',
              ),
            );
        } catch (error) {
          diagnostics.push(
            cliDiagnostic(
              'native.shader.compile',
              '/shaders',
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      }
    }

    // Validate the entire admitted authored generation before publishing any
    // result, including when a native tool took long enough for disk edits.
    const proof = await native({
      action: 'source-generation-proof',
      projectRoot,
      expectedSourceGeneration: checked.sourceGeneration,
    });
    if (!proof.ok)
      return fail(
        'WORKSPACE_REVISION_CONFLICT',
        proof.error ?? 'Project sources changed during validation.',
        5,
      );
    for (const [relative, revision] of physicalRevisions) {
      try {
        const current = await fileSystem.readFileRevision(
          fileSystem.joinPath(projectRoot, relative),
        );
        if (`${current.contentHash}:${current.byteSize}` !== revision)
          return fail(
            'WORKSPACE_REVISION_CONFLICT',
            `Asset source changed during validation: ${relative}`,
            5,
          );
      } catch {
        return fail(
          'WORKSPACE_REVISION_CONFLICT',
          `Asset source changed during validation: ${relative}`,
          5,
        );
      }
    }
    for (const [relative, previousKind] of unavailableAssetKinds) {
      const absolute = fileSystem.joinPath(projectRoot, relative);
      const currentKind =
        (await fileSystem
          .readPathMetadata?.(absolute)
          .then((item) => item.kind)
          .catch(() => 'missing')) ?? 'missing';
      if (currentKind !== previousKind)
        return fail(
          'WORKSPACE_REVISION_CONFLICT',
          `Asset source changed during validation: ${relative}`,
          5,
        );
    }
    const missingLocations = diagnostics.flatMap((diagnostic, index) =>
      diagnostic.sourceUrl && diagnostic.line !== undefined ? [] : [index],
    );
    if (missingLocations.length) {
      const locations = await native({
        action: 'project-diagnostic-locations',
        projectRoot,
        expectedSourceGeneration: checked.sourceGeneration,
        paths: missingLocations.map((index) => diagnostics[index]!.path),
      });
      if (!locations.ok)
        return fail(
          'WORKSPACE_REVISION_CONFLICT',
          locations.error ?? 'Native diagnostic source authority changed.',
          5,
        );
      if (
        !Array.isArray(locations.locations) ||
        locations.locations.length !== missingLocations.length
      )
        return fail(
          'NATIVE_PROJECT_VALIDATION_UNAVAILABLE',
          'Native diagnostic location response is malformed.',
          70,
        );
      for (let index = 0; index < missingLocations.length; index++) {
        const location = locations.locations[index];
        if (
          !location ||
          typeof location !== 'object' ||
          Array.isArray(location) ||
          typeof location.sourceUrl !== 'string' ||
          !Number.isSafeInteger(location.line) ||
          !Number.isSafeInteger(location.column)
        )
          return fail(
            'NATIVE_PROJECT_VALIDATION_UNAVAILABLE',
            'Native diagnostic location is malformed.',
            70,
          );
        const diagnosticIndex = missingLocations[index]!;
        diagnostics[diagnosticIndex] = {
          ...diagnostics[diagnosticIndex]!,
          sourceUrl: location.sourceUrl,
          line: location.line as number,
          column: location.column as number,
        };
      }
    }
    if (stageCache && cacheChanged) await publishValidationStageCache(fileSystem, stageCache);
    const success = !diagnostics.some((item) => item.severity === 'error');
    return formatCliResult(
      {
        success,
        exitCode: success
          ? NOVELTEA_CLI_EXIT_CODES.success
          : diagnostics.some((item) => item.code.startsWith('native.'))
            ? NOVELTEA_CLI_EXIT_CODES.native
            : NOVELTEA_CLI_EXIT_CODES.semantic,
        diagnostics,
        projectRoot,
      },
      globals.json,
      { success: 'NovelTea validate succeeded.', failure: 'NovelTea validate failed.' },
    );
  } catch (error) {
    return fail(
      'NATIVE_PROJECT_VALIDATION_UNAVAILABLE',
      error instanceof Error ? error.message : String(error),
      70,
    );
  }
}
