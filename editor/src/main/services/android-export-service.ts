import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildPlatformDeployment } from '../../shared/project-schema/platform-deployment';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-validation';
import {
  PLAYER_CONFIG_FORMAT,
  PLAYER_CONFIG_FORMAT_VERSION,
  PLATFORM_EXPORT_MANIFEST_FORMAT,
  PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION,
  type PlatformExportManifest,
  type PlatformStageDiagnostic,
  type PlatformStageRequest,
  type PlatformStageResult,
  type StagedFileEntry,
  type TemplateDescriptor,
} from '../../shared/project-schema/platform-export-contracts';
import { checkPlatformExportCancelled } from './platform-staging-service';
import { generateAppIcons } from './icon-generation-service';
import { probeAndroidToolchain } from './android-toolchain-service';
import { verifyTemplateToken } from './template-registry-service';
import { inspectAndroidArtifacts } from './android-artifact-inspection-service';

const run = promisify(execFile);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const errorDiagnostic = (
  code: string,
  pathValue: string,
  message: string,
): PlatformStageDiagnostic =>
  createPlatformExportValidationDiagnostic({
    severity: 'error',
    code,
    path: pathValue,
    message,
  });
const platformDiagnostics = (
  diagnostics: ReadonlyArray<{
    severity: 'info' | 'warning' | 'error';
    code: string;
    path: string;
    message: string;
  }>,
): PlatformStageDiagnostic[] =>
  diagnostics.map((item) => createPlatformExportValidationDiagnostic(item));
const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const property = (value: string) =>
  value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('=', '\\=')
    .replaceAll(':', '\\:');
const safeName = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'game';

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Android template contains forbidden symbolic link '${relative}'.`);
    if (entry.isDirectory()) result.push(...(await listFiles(root, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

async function copyTree(source: string, destination: string) {
  await listFiles(source);
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
}

export async function publishAndroidArtifactSet(
  stagedDirectory: string,
  outputDirectory: string,
  operationId: string,
) {
  const output = path.resolve(outputDirectory);
  const backup = `${output}.previous-${operationId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  let backedUp = false;
  await mkdir(path.dirname(output), { recursive: true });
  await rm(backup, { recursive: true, force: true });
  try {
    if (await stat(output).catch(() => null)) {
      await rename(output, backup);
      backedUp = true;
    }
    await rename(stagedDirectory, output);
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    if (backedUp && (await stat(backup).catch(() => null))) await rename(backup, output);
    throw error;
  }
}

async function trackedFiles(root: string): Promise<StagedFileEntry[]> {
  const files: StagedFileEntry[] = [];
  for (const relative of await listFiles(root)) {
    const data = await readFile(path.join(root, relative));
    const info = await stat(path.join(root, relative));
    const origin = relative.endsWith('game.ntpkg')
      ? ('runtime-package' as const)
      : relative.includes('/res/mipmap-') || relative.includes('/res/drawable/')
        ? ('icon' as const)
        : relative.includes('/assets/system/')
          ? ('system-asset' as const)
          : ('generated-metadata' as const);
    files.push({
      path: relative,
      origin,
      originId: `android:${relative}`,
      size: data.length,
      mode: info.mode & 0o777,
      sha256: sha256(data),
    });
  }
  return files;
}

export function buildAndroidManifest(
  request: PlatformStageRequest,
  descriptor: TemplateDescriptor,
) {
  if (request.profile.target !== 'android' || !descriptor.android)
    throw new Error('Android manifest requires Android contracts.');
  const deployment = request.profile;
  const permissions = [
    ...new Set([...(request.capabilities ?? []), ...deployment.capabilityOverrides]),
  ];
  const metadata = buildPlatformDeployment(request, descriptor).model?.capabilityMetadata;
  const permissionXml = (metadata?.androidPermissions ?? [])
    .map((name) => `    <uses-permission android:name="${xml(name)}" />`)
    .join('\n');
  const featureXml = (metadata?.androidFeatures ?? [])
    .map((name) => `    <uses-feature android:name="${xml(name)}" android:required="false" />`)
    .join('\n');
  const orientation =
    request.display.orientation === 'portrait' ? 'sensorPortrait' : 'sensorLandscape';
  const allowBackup = request.identity.androidAllowBackup ?? false;
  const appCategory = (request.identity.androidIsGame ?? true) ? ' android:appCategory="game"' : '';
  void permissions;
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
${permissionXml ? `${permissionXml}\n` : ''}    <uses-feature android:glEsVersion="0x00030000" android:required="true" />
${featureXml ? `${featureXml}\n` : ''}    <application android:allowBackup="${allowBackup}" android:dataExtractionRules="@xml/data_extraction_rules" android:fullBackupContent="@xml/backup_rules" android:hasCode="true" android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round" android:label="@string/noveltea_app_name" android:theme="@style/NovelTeaGeneratedTheme"${appCategory}>
        <activity android:name="${xml(descriptor.android.activityClass)}" android:configChanges="orientation|screenSize|screenLayout|keyboardHidden" android:exported="true" android:screenOrientation="${orientation}" android:theme="@style/NovelTeaGeneratedTheme">
            <meta-data android:name="android.app.lib_name" android:value="${xml(descriptor.android.nativeLibraryName)}" />
            <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
        </activity>
    </application>
</manifest>
`;
}

export async function generateAndroidInputs(
  request: PlatformStageRequest,
  descriptor: TemplateDescriptor,
  generatedRoot: string,
  deployment: NonNullable<ReturnType<typeof buildPlatformDeployment>['model']>,
) {
  if (request.profile.target !== 'android' || !descriptor.android || !deployment.android)
    throw new Error('Android generated inputs require normalized Android deployment.');
  const res = path.join(generatedRoot, 'res');
  const assets = path.join(generatedRoot, 'assets', 'noveltea', 'bootstrap');
  await mkdir(path.join(res, 'values'), { recursive: true });
  await mkdir(path.join(res, 'values-v31'), { recursive: true });
  await mkdir(path.join(res, 'xml'), { recursive: true });
  await mkdir(assets, { recursive: true });
  await writeFile(
    path.join(generatedRoot, 'AndroidManifest.xml'),
    buildAndroidManifest(request, descriptor),
  );
  await writeFile(
    path.join(res, 'values', 'strings.xml'),
    `<resources><string name="noveltea_app_name">${xml(request.identity.displayName)}</string></resources>\n`,
  );
  for (const [locale, localized] of Object.entries(request.identity.localized ?? {})) {
    if (!localized.displayName) continue;
    const qualifier = `b+${locale
      .split('-')
      .map((part) => part.replace(/[^A-Za-z0-9]/g, ''))
      .filter(Boolean)
      .join('+')}`;
    const directory = path.join(res, `values-${qualifier}`);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'strings.xml'),
      `<resources><string name="noveltea_app_name">${xml(localized.displayName)}</string></resources>\n`,
    );
  }
  const background = request.identity.backgroundColor ?? '#000000';
  await writeFile(
    path.join(res, 'values', 'colors.xml'),
    `<resources><color name="noveltea_launch_background">${xml(background)}</color></resources>\n`,
  );
  await writeFile(
    path.join(res, 'values', 'styles.xml'),
    '<resources><style name="NovelTeaGeneratedTheme" parent="android:Theme.NoTitleBar.Fullscreen"><item name="android:windowFullscreen">true</item><item name="android:windowBackground">@color/noveltea_launch_background</item></style></resources>\n',
  );
  await writeFile(
    path.join(res, 'values-v31', 'styles.xml'),
    '<resources><style name="NovelTeaGeneratedTheme" parent="android:Theme.NoTitleBar.Fullscreen"><item name="android:windowSplashScreenBackground">@color/noveltea_launch_background</item><item name="android:windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item><item name="android:windowFullscreen">true</item></style></resources>\n',
  );
  const backupEnabled = deployment.android.allowBackup;
  await writeFile(
    path.join(res, 'xml', 'backup_rules.xml'),
    backupEnabled
      ? '<full-backup-content />\n'
      : '<full-backup-content><exclude domain="root" path="." /></full-backup-content>\n',
  );
  await writeFile(
    path.join(res, 'xml', 'data_extraction_rules.xml'),
    backupEnabled
      ? '<data-extraction-rules><cloud-backup /><device-transfer /></data-extraction-rules>\n'
      : '<data-extraction-rules><cloud-backup><exclude domain="root" path="." /></cloud-backup><device-transfer><exclude domain="root" path="." /></device-transfer></data-extraction-rules>\n',
  );
  const packageData = await readFile(request.packagePath);
  const packageHash = sha256(packageData);
  const playerConfig = {
    format: PLAYER_CONFIG_FORMAT,
    formatVersion: PLAYER_CONFIG_FORMAT_VERSION,
    displayName: request.identity.displayName,
    applicationId: request.identity.applicationId,
    saveNamespace: request.identity.saveNamespace,
    versionName: request.identity.versionName,
    ...(request.identity.defaultLocale ? { defaultLocale: request.identity.defaultLocale } : {}),
    package: {
      path: 'game.ntpkg',
      sha256: packageHash,
      runtimePackageApi: request.runtimePackageApi,
    },
    capabilities: deployment.capabilities,
    display: request.display,
  };
  await writeFile(path.join(assets, 'player.json'), `${JSON.stringify(playerConfig, null, 2)}\n`);
  await writeFile(path.join(assets, 'game.ntpkg'), packageData);
  const iconRoot = path.join(generatedRoot, '.icons');
  const icons = await generateAppIcons({
    sourcePath: request.iconSourcePath!,
    stagingRoot: iconRoot,
    backgroundColor: background,
    platforms: ['android'],
  });
  if (!icons.ok) throw new Error(icons.diagnostics.map((item) => item.message).join('; '));
  await cp(path.join(iconRoot, 'android', 'res'), res, { recursive: true });
  await rm(iconRoot, { recursive: true, force: true });
  const files = await trackedFiles(generatedRoot);
  const exportManifest: PlatformExportManifest = {
    format: PLATFORM_EXPORT_MANIFEST_FORMAT,
    formatVersion: PLATFORM_EXPORT_MANIFEST_FORMAT_VERSION,
    deployment,
    files,
  };
  await writeFile(
    path.join(assets, 'export-manifest.json'),
    `${JSON.stringify(exportManifest, null, 2)}\n`,
  );
  return { packageHash, playerConfig, exportManifest };
}

function expectedOutput(
  gradleRoot: string,
  module: string,
  kind: 'apk' | 'aab',
  flavor: 'debug' | 'release',
  signed: boolean,
) {
  if (kind === 'aab')
    return path.join(
      gradleRoot,
      module,
      'build',
      'outputs',
      'bundle',
      flavor,
      `${module}-${flavor}.aab`,
    );
  return path.join(
    gradleRoot,
    module,
    'build',
    'outputs',
    'apk',
    flavor,
    `${module}-${flavor}${flavor === 'release' && !signed ? '-unsigned' : ''}.apk`,
  );
}

export async function exportAndroidPlatform(
  request: PlatformStageRequest,
  descriptor: TemplateDescriptor,
  templateRoot: string,
): Promise<PlatformStageResult> {
  if (request.profile.target !== 'android' || !descriptor.android)
    throw new Error('Android export service requires an Android profile and descriptor.');
  const temp = `${path.resolve(request.outputDirectory)}.android-tmp-${request.operationId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const publish = path.join(temp, 'publish');
  const project = path.join(temp, 'template');
  const generated = path.join(temp, 'generated');
  try {
    checkPlatformExportCancelled(request.operationId);
    const verified = await verifyTemplateToken(request.templateToken);
    if (
      verified.descriptor.templateId !== descriptor.templateId ||
      verified.descriptor.buildId !== descriptor.buildId
    )
      throw new Error('Android template changed after resolution.');
    const built = buildPlatformDeployment(request, verified.descriptor);
    if (!built.model || built.diagnostics.some((item) => item.severity === 'error'))
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: built.diagnostics,
      };
    const local = request.androidToolchain ?? {};
    const probe = await probeAndroidToolchain({
      ...local,
      compileSdk: descriptor.android.compileSdk,
      buildToolsVersion: descriptor.android.toolchain.buildTools,
      gradleWrapper: path.join(templateRoot, descriptor.android.gradleWrapperPath),
      bundletool: path.join(templateRoot, descriptor.android.bundletoolPath),
      expectedVersions: {
        java: descriptor.android.toolchain.java,
        gradle: descriptor.android.toolchain.gradle,
        'sdk-platform': String(descriptor.android.compileSdk),
        aapt2: descriptor.android.toolchain.buildTools,
        zipalign: descriptor.android.toolchain.buildTools,
        apksigner: descriptor.android.toolchain.buildTools,
        'ndk-clang': descriptor.android.toolchain.ndk,
        cmake: descriptor.android.toolchain.cmake,
        bundletool: descriptor.android.toolchain.bundletool,
      },
    });
    if (!probe.ok)
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: platformDiagnostics(probe.diagnostics),
        deployment: built.model,
      };
    await rm(temp, { recursive: true, force: true });
    await mkdir(temp, { recursive: true });
    await copyTree(templateRoot, project);
    await mkdir(publish, { recursive: true });
    const generatedResult = await generateAndroidInputs(
      request,
      descriptor,
      generated,
      built.model,
    );
    const sdk = local.androidSdk!;
    const ndk = local.androidNdk!;
    const javaHome = local.javaHome!;
    const gradleRoot = path.join(project, descriptor.android.gradleProjectRoot);
    const gradlew = path.join(project, descriptor.android.gradleWrapperPath);
    const propertiesPath = path.join(generated, 'noveltea.properties');
    await writeFile(
      propertiesPath,
      [
        `novelteaApplicationId=${property(built.model.android!.applicationId)}`,
        `novelteaVersionCode=${built.model.android!.versionCode}`,
        `novelteaVersionName=${property(built.model.android!.versionName)}`,
        `novelteaAbi=${built.model.android!.abi}`,
        `novelteaOrientation=${built.model.android!.orientation}`,
      ].join('\n') + '\n',
    );
    await writeFile(
      path.join(gradleRoot, 'local.properties'),
      `sdk.dir=${property(sdk)}\nndk.dir=${property(ndk)}\n${local.cmake ? `cmake.dir=${property(local.cmake)}\n` : ''}`,
    );
    const flavor = request.profile.buildFlavor;
    const capital = flavor === 'release' ? 'Release' : 'Debug';
    if (request.androidSigning && flavor !== 'release') {
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: [
          errorDiagnostic(
            'android-signing-debug-profile',
            '/localState/signing/android',
            'Android release signing can only be used with a release export profile.',
          ),
        ],
        deployment: built.model,
      };
    }
    const signingPropertiesPath = request.androidSigning
      ? path.join(temp, 'signing.properties')
      : undefined;
    if (request.androidSigning && signingPropertiesPath) {
      await writeFile(
        signingPropertiesPath,
        [
          `storeFile=${property(request.androidSigning.keystorePath)}`,
          `storePassword=${property(request.androidSigning.storePassword)}`,
          `keyAlias=${property(request.androidSigning.keyAlias)}`,
          `keyPassword=${property(request.androidSigning.keyPassword)}`,
        ].join('\n') + '\n',
        { mode: 0o600 },
      );
    }
    const signingArguments = signingPropertiesPath
      ? [`-PnovelteaSigningProperties=${signingPropertiesPath}`]
      : [];
    const kinds = built.model.android!.artifacts;
    const tasks = kinds.map((kind) =>
      kind === 'apk'
        ? `:${descriptor.android!.applicationModule}:assemble${capital}`
        : `:${descriptor.android!.applicationModule}:bundle${capital}`,
    );
    try {
      for (const task of tasks) {
        checkPlatformExportCancelled(request.operationId);
        await run(
          gradlew,
          [
            task,
            '--no-daemon',
            '--stacktrace',
            '-PnovelteaCompileShaders=OFF',
            `-PnovelteaPrebuiltShaderAssetRoot=${path.join(gradleRoot, 'prebuilt-shaders')}`,
            `-PnovelteaGeneratedRoot=${generated}`,
            `-PnovelteaGeneratedProperties=${propertiesPath}`,
            ...signingArguments,
          ],
          {
            cwd: gradleRoot,
            env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
            maxBuffer: 16 * 1024 * 1024,
          },
        );
      }
    } catch (error) {
      let message =
        error instanceof Error
          ? error.message
              .replaceAll(javaHome, '<JAVA_HOME>')
              .replaceAll(sdk, '<ANDROID_SDK>')
              .replaceAll(ndk, '<ANDROID_NDK>')
          : String(error);
      for (const secret of [
        request.androidSigning?.storePassword,
        request.androidSigning?.keyPassword,
      ]) {
        if (secret) message = message.replaceAll(secret, '<SIGNING_SECRET>');
      }
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: [errorDiagnostic('android-gradle-failed', '/gradle', message)],
        deployment: built.model,
      };
    }
    checkPlatformExportCancelled(request.operationId);
    const stem = `${safeName(request.identity.shortName ?? request.identity.displayName)}-${safeName(request.identity.versionName)}-android-${built.model.android!.abi}`;
    const artifacts: NonNullable<PlatformStageResult['artifacts']> = [];
    const inspectionArtifacts: Array<{ kind: 'apk' | 'aab'; path: string }> = [];
    for (const kind of kinds) {
      const source = expectedOutput(
        gradleRoot,
        descriptor.android.applicationModule,
        kind,
        flavor,
        Boolean(request.androidSigning),
      );
      await lstat(source);
      const destination = path.join(publish, `${stem}.${kind}`);
      await cp(source, destination);
      artifacts.push({
        kind,
        path: path.join(path.resolve(request.outputDirectory), path.basename(destination)),
        size: (await stat(destination)).size,
      });
      inspectionArtifacts.push({ kind, path: destination });
    }
    const inspection = await inspectAndroidArtifacts({
      artifacts: inspectionArtifacts,
      deployment: built.model,
      descriptor,
      packageSha256: generatedResult.packageHash,
      temporaryRoot: path.join(temp, 'inspection'),
      probe,
      local: {
        javaHome,
        androidSdk: sdk,
        androidNdk: ndk,
        cmake: probe.tools.find((tool) => tool.name === 'cmake')?.executable,
      },
      signingExpected: Boolean(request.androidSigning),
    });
    if (!inspection.ok)
      return {
        ok: false,
        success: false,
        cancelled: false,
        operationId: request.operationId,
        diagnostics: inspection.diagnostics,
        deployment: built.model,
      };
    const reportName = `${stem}-export-report.json`;
    const report = {
      format: 'noveltea.android-export-report',
      formatVersion: 1,
      operationId: request.operationId,
      deployment: built.model.android,
      template: { id: descriptor.templateId, buildId: descriptor.buildId },
      package: { sha256: generatedResult.packageHash },
      signing: {
        requested: Boolean(request.androidSigning),
        mode: request.androidSigning
          ? 'release-keystore'
          : flavor === 'release'
            ? 'unsigned'
            : 'debug',
      },
      toolchain: Object.fromEntries(
        probe.tools.map((tool) => [
          tool.name,
          { required: tool.required, ok: tool.ok, version: tool.version },
        ]),
      ),
      artifacts: artifacts.map((artifact) => ({
        kind: artifact.kind,
        file: path.basename(artifact.path),
        size: artifact.size,
      })),
      verification: inspection.verification,
    };
    await writeFile(path.join(publish, reportName), `${JSON.stringify(report, null, 2)}\n`);
    artifacts.push({
      kind: 'archive',
      path: path.join(path.resolve(request.outputDirectory), reportName),
      size: (await stat(path.join(publish, reportName))).size,
    });
    await publishAndroidArtifactSet(publish, request.outputDirectory, request.operationId);
    return {
      ok: true,
      success: true,
      cancelled: false,
      operationId: request.operationId,
      outputDirectory: path.resolve(request.outputDirectory),
      artifacts,
      diagnostics: [...platformDiagnostics(probe.diagnostics), ...inspection.diagnostics],
      deployment: built.model,
      manifest: generatedResult.exportManifest,
    };
  } catch (error) {
    if (error instanceof Error && error.message === 'NOVELTEA_EXPORT_CANCELLED')
      return {
        ok: false,
        success: false,
        cancelled: true,
        operationId: request.operationId,
        diagnostics: [
          createPlatformExportValidationDiagnostic({
            severity: 'warning',
            code: 'export-cancelled',
            path: '/',
            message: 'Android export was cancelled.',
          }),
        ],
      };
    return {
      ok: false,
      success: false,
      cancelled: false,
      operationId: request.operationId,
      diagnostics: [
        errorDiagnostic(
          'android-export-failed',
          '/',
          error instanceof Error ? error.message : String(error),
        ),
      ],
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
