import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  PlatformDeploymentModel,
  PlatformStageDiagnostic,
  TemplateDescriptor,
} from '../../shared/project-schema/platform-export-contracts';
import { createPlatformExportValidationDiagnostic } from '../../shared/project-schema/project-validation';
import type { AndroidToolchainProbeResult } from './android-toolchain-service';

const run = promisify(execFile);
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const diagnostic = (code: string, pathValue: string, message: string): PlatformStageDiagnostic =>
  createPlatformExportValidationDiagnostic({
    severity: 'error',
    code,
    path: pathValue,
    message,
  });
const parseNames = (text: string, prefix: string) =>
  [...text.matchAll(new RegExp(`^${prefix}: name='([^']+)'`, 'gm'))]
    .map((match) => match[1]!)
    .sort();

export interface AndroidArtifactInspectionRequest {
  artifacts: Array<{ kind: 'apk' | 'aab'; path: string }>;
  deployment: PlatformDeploymentModel;
  descriptor: TemplateDescriptor;
  packageSha256: string;
  temporaryRoot: string;
  probe: AndroidToolchainProbeResult;
  local: { javaHome: string; androidSdk: string };
  signingExpected: boolean;
}

export interface AndroidArtifactInspectionResult {
  ok: boolean;
  diagnostics: PlatformStageDiagnostic[];
  verification: Record<string, unknown>;
  apkSetPath?: string;
}

function tool(probe: AndroidToolchainProbeResult, name: string) {
  const found = probe.tools.find((item) => item.name === name && item.ok)?.executable;
  if (!found) throw new Error(`Verified Android tool '${name}' is unavailable.`);
  return found;
}

async function extractArchive(archive: string, destination: string, javaHome: string) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const jar = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  await run(jar, ['xf', archive], { cwd: destination, maxBuffer: 16 * 1024 * 1024 });
}

function exactSet(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    actual.every((item, index) => item === [...expected].sort()[index])
  );
}

async function inspectApk(
  apk: string,
  request: AndroidArtifactInspectionRequest,
  label: string,
  verificationIntermediate = false,
) {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const android = request.deployment.android!;
  const aapt2 = tool(request.probe, 'aapt2');
  const zipalign = tool(request.probe, 'zipalign');
  const apksigner = tool(request.probe, 'apksigner');
  let badging = '';
  let xmltree = '';
  try {
    badging = (await run(aapt2, ['dump', 'badging', apk], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'android-manifest-unreadable',
        label,
        `aapt2 could not inspect the manifest: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  try {
    xmltree = (
      await run(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk], {
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'android-manifest-unreadable',
        label,
        `aapt2 could not inspect manifest attributes: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const packageMatch = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'/m.exec(
    badging,
  );
  if (!packageMatch || packageMatch[1] !== android.applicationId)
    diagnostics.push(
      diagnostic(
        'android-package-id-mismatch',
        label,
        `Expected application ID '${android.applicationId}', found '${packageMatch?.[1] ?? 'unknown'}'.`,
      ),
    );
  if (
    !packageMatch ||
    Number(packageMatch[2]) !== android.versionCode ||
    packageMatch[3] !== android.versionName
  )
    diagnostics.push(
      diagnostic(
        'android-version-mismatch',
        label,
        'Android version code/name does not match the deployment model.',
      ),
    );
  const minSdk = Number(/^minSdkVersion:'([^']+)'/m.exec(badging)?.[1]);
  const targetSdk = Number(/^targetSdkVersion:'([^']+)'/m.exec(badging)?.[1]);
  if (minSdk !== android.minSdk || targetSdk !== android.targetSdk)
    diagnostics.push(
      diagnostic(
        'android-sdk-mismatch',
        label,
        `Expected min/target SDK ${android.minSdk}/${android.targetSdk}, found ${minSdk}/${targetSdk}.`,
      ),
    );
  const permissions = parseNames(badging, 'uses-permission');
  if (!exactSet(permissions, request.deployment.capabilityMetadata.androidPermissions))
    diagnostics.push(
      diagnostic(
        'android-permission-closure-mismatch',
        label,
        `Packaged permissions [${permissions.join(', ')}] do not match declared capability permissions [${request.deployment.capabilityMetadata.androidPermissions.join(', ')}].`,
      ),
    );
  const explicitFeatures: string[] = [];
  let inFeature = false;
  for (const line of xmltree.split('\n')) {
    if (/E: uses-feature\b/.test(line)) {
      inFeature = true;
      continue;
    }
    if (inFeature && /E: /.test(line)) inFeature = false;
    if (inFeature) {
      const name = /:name\([^)]*\)="([^"]+)"/.exec(line)?.[1];
      if (name) explicitFeatures.push(name);
    }
  }
  const expectedFeatures = [...request.deployment.capabilityMetadata.androidFeatures].sort();
  if (!exactSet(explicitFeatures.sort(), expectedFeatures))
    diagnostics.push(
      diagnostic(
        'android-feature-closure-mismatch',
        label,
        `Explicit packaged features [${explicitFeatures.join(', ')}] do not match capability-derived features [${expectedFeatures.join(', ')}].`,
      ),
    );
  for (const [needle, code, message] of [
    [`:label(0x01010001)=@0x`, 'android-label-missing', 'Application label resource is missing.'],
    [`:icon(0x01010002)=@0x`, 'android-icon-missing', 'Launcher icon resource is missing.'],
    [
      `:roundIcon(0x0101052c)=@0x`,
      'android-round-icon-missing',
      'Round launcher icon resource is missing.',
    ],
    [
      `:exported(0x01010010)=true`,
      'android-exported-mismatch',
      'Launcher activity is not deliberately exported.',
    ],
    [
      `:screenOrientation(0x0101001e)=`,
      'android-orientation-missing',
      'Screen orientation is missing.',
    ],
  ] as const)
    if (!xmltree.includes(needle)) diagnostics.push(diagnostic(code, label, message));
  const expectedOrientation = request.deployment.display.orientation === 'portrait' ? 7 : 6;
  if (!xmltree.includes(`:screenOrientation(0x0101001e)=${expectedOrientation}`))
    diagnostics.push(
      diagnostic(
        'android-orientation-mismatch',
        label,
        `Resolved orientation does not match '${request.deployment.display.orientation}'.`,
      ),
    );
  const expectedBackup = request.deployment.android!.allowBackup ? 'true' : 'false';
  if (
    !xmltree.includes(`:allowBackup(0x01010280)=${expectedBackup}`) ||
    !/:dataExtractionRules\([^)]*\)=@0x/.test(xmltree) ||
    !/:fullBackupContent\([^)]*\)=@0x/.test(xmltree)
  )
    diagnostics.push(
      diagnostic(
        'android-backup-policy-mismatch',
        label,
        'Backup/data-extraction policy does not match the deployment model.',
      ),
    );
  if (request.deployment.android!.isGame && !/:appCategory\([^)]*\)=0/.test(xmltree))
    diagnostics.push(
      diagnostic(
        'android-game-classification-mismatch',
        label,
        'Application is not classified as a game.',
      ),
    );
  const componentCount = (xmltree.match(/E: (?:activity|service|receiver|provider)\b/g) ?? [])
    .length;
  if (
    componentCount !== 1 ||
    !xmltree.includes(request.descriptor.android!.activityClass) ||
    !xmltree.includes(request.descriptor.android!.nativeLibraryName)
  )
    diagnostics.push(
      diagnostic(
        'android-component-closure-mismatch',
        label,
        'Manifest component/native-library closure differs from the immutable player contract.',
      ),
    );
  const extract = path.join(
    request.temporaryRoot,
    `extract-${label.replace(/[^A-Za-z0-9]/g, '-')}`,
  );
  try {
    await extractArchive(apk, extract, request.local.javaHome);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'android-archive-unreadable',
        label,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return { diagnostics, signature: 'unknown', nativeLibraries: [] };
  }
  const packagePath = path.join(extract, 'assets', 'noveltea', 'bootstrap', 'game.ntpkg');
  const configPath = path.join(extract, 'assets', 'noveltea', 'bootstrap', 'player.json');
  try {
    const packageHash = sha256(await readFile(packagePath));
    const player = JSON.parse(await readFile(configPath, 'utf8')) as {
      package?: { sha256?: string };
    };
    if (packageHash !== request.packageSha256 || player.package?.sha256 !== packageHash)
      diagnostics.push(
        diagnostic(
          'android-package-checksum-mismatch',
          label,
          'Packaged game, player config, and export provenance SHA-256 values disagree.',
        ),
      );
  } catch (error) {
    diagnostics.push(
      diagnostic(
        'android-bootstrap-assets-missing',
        label,
        `Packaged bootstrap assets are missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const abiRoot = path.join(extract, 'lib');
  let abiDirectories: string[] = [];
  try {
    abiDirectories = (await readdir(abiRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    /* diagnosed below */
  }
  if (!exactSet(abiDirectories, [android.abi]))
    diagnostics.push(
      diagnostic(
        'android-abi-closure-mismatch',
        label,
        `Expected only ABI '${android.abi}', found [${abiDirectories.join(', ')}].`,
      ),
    );
  const nativeRoot = path.join(abiRoot, android.abi);
  let nativeFiles: string[] = [];
  try {
    nativeFiles = (await readdir(nativeRoot)).filter((name) => name.endsWith('.so')).sort();
  } catch {
    /* diagnosed through native closure */
  }
  const nativePrefix = `source/android/prebuilt-native/${android.abi}/`;
  const expectedNativeNames = request.descriptor.files
    .filter((entry) => entry.path.startsWith(nativePrefix) && entry.path.endsWith('.so'))
    .map((entry) => entry.path.slice(nativePrefix.length))
    .sort((left, right) => left.localeCompare(right));
  if (!exactSet(nativeFiles, expectedNativeNames))
    diagnostics.push(
      diagnostic(
        'android-native-library-closure-mismatch',
        label,
        `Packaged native libraries [${nativeFiles.join(', ')}] do not match the template closure [${expectedNativeNames.join(', ')}].`,
      ),
    );
  try {
    await run(zipalign, ['-c', '-P', '16', '4', apk]);
  } catch {
    diagnostics.push(
      diagnostic(
        'android-zip-alignment-mismatch',
        label,
        'APK does not pass zipalign with 16 KiB native-library alignment.',
      ),
    );
  }
  let signature = 'unsigned';
  try {
    await run(apksigner, ['verify', '--verbose', apk]);
    signature = 'verified';
  } catch {
    signature = 'unsigned';
  }
  if (request.deployment.buildFlavor === 'debug' && signature !== 'verified')
    diagnostics.push(
      diagnostic(
        'android-debug-signature-missing',
        label,
        'Debug APK is not signed with an installable debug signature.',
      ),
    );
  if (request.deployment.buildFlavor === 'release' && !verificationIntermediate) {
    if (request.signingExpected && signature !== 'verified')
      diagnostics.push(
        diagnostic(
          'android-release-signature-missing',
          label,
          'Signed release APK did not pass apksigner verification.',
        ),
      );
    if (!request.signingExpected && signature === 'verified')
      diagnostics.push(
        diagnostic(
          'android-release-signature-unexpected',
          label,
          'Unsigned release export unexpectedly contains a verified APK signature.',
        ),
      );
  }
  return {
    diagnostics,
    signature:
      verificationIntermediate && signature === 'verified'
        ? 'debug-signed-verification'
        : signature,
    nativeLibraries: nativeFiles,
  };
}

export async function inspectAndroidArtifacts(
  request: AndroidArtifactInspectionRequest,
): Promise<AndroidArtifactInspectionResult> {
  const diagnostics: PlatformStageDiagnostic[] = [];
  const inspected: Record<string, unknown>[] = [];
  let apkSetPath: string | undefined;
  for (const artifact of request.artifacts) {
    const size = (await stat(artifact.path)).size;
    const limit = artifact.kind === 'apk' ? 200 * 1024 * 1024 : 1024 * 1024 * 1024;
    if (size > limit)
      diagnostics.push(
        diagnostic(
          'android-artifact-size-limit',
          artifact.path,
          `${artifact.kind.toUpperCase()} exceeds the supported ${limit / 1024 / 1024} MiB export limit.`,
        ),
      );
    if (artifact.kind === 'apk') {
      const result = await inspectApk(artifact.path, request, path.basename(artifact.path));
      diagnostics.push(...result.diagnostics);
      inspected.push({
        kind: 'apk',
        size,
        signature: result.signature,
        nativeLibraries: result.nativeLibraries,
      });
    } else {
      const bundletool = tool(request.probe, 'bundletool');
      const java = tool(request.probe, 'java');
      apkSetPath = path.join(request.temporaryRoot, 'verification.apks');
      try {
        const bundleExtract = path.join(request.temporaryRoot, 'bundle');
        await extractArchive(artifact.path, bundleExtract, request.local.javaHome);
        const bundleAbiRoot = path.join(bundleExtract, 'base', 'lib');
        const bundleAbis = (await readdir(bundleAbiRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
        if (!exactSet(bundleAbis, [request.deployment.android!.abi]))
          diagnostics.push(
            diagnostic(
              'android-aab-abi-closure-mismatch',
              artifact.path,
              `AAB contains ABIs [${bundleAbis.join(', ')}], expected only '${request.deployment.android!.abi}'.`,
            ),
          );
        const bundlePackage = await readFile(
          path.join(bundleExtract, 'base', 'assets', 'noveltea', 'bootstrap', 'game.ntpkg'),
        );
        const bundlePlayer = JSON.parse(
          await readFile(
            path.join(bundleExtract, 'base', 'assets', 'noveltea', 'bootstrap', 'player.json'),
            'utf8',
          ),
        ) as { package?: { sha256?: string } };
        if (
          sha256(bundlePackage) !== request.packageSha256 ||
          bundlePlayer.package?.sha256 !== request.packageSha256
        )
          diagnostics.push(
            diagnostic(
              'android-aab-package-checksum-mismatch',
              artifact.path,
              'AAB bootstrap package/config hashes differ from export provenance.',
            ),
          );
        const jarsigner = path.join(
          request.local.javaHome,
          'bin',
          process.platform === 'win32' ? 'jarsigner.exe' : 'jarsigner',
        );
        let bundleSignature = 'unsigned';
        try {
          const verified = await run(jarsigner, ['-verify', '-verbose', '-certs', artifact.path], {
            maxBuffer: 16 * 1024 * 1024,
          });
          const output = `${verified.stdout}\n${verified.stderr}`;
          bundleSignature =
            /jar verified\./i.test(output) && !/jar is unsigned/i.test(output)
              ? 'verified'
              : 'unsigned';
        } catch {
          /* reported below according to the requested signing mode */
        }
        if (request.signingExpected && bundleSignature !== 'verified')
          diagnostics.push(
            diagnostic(
              'android-aab-signature-missing',
              artifact.path,
              'Signed release AAB did not pass JAR signature verification.',
            ),
          );
        if (!request.signingExpected && bundleSignature !== 'unsigned')
          diagnostics.push(
            diagnostic(
              'android-aab-signature-unexpected',
              artifact.path,
              'Unsigned release export unexpectedly contains a verified AAB signature.',
            ),
          );
        await run(
          java,
          [
            '-jar',
            bundletool,
            'build-apks',
            `--bundle=${artifact.path}`,
            `--output=${apkSetPath}`,
            '--mode=universal',
            '--overwrite',
          ],
          { maxBuffer: 16 * 1024 * 1024 },
        );
        const apkSetExtract = path.join(request.temporaryRoot, 'apk-set');
        await extractArchive(apkSetPath, apkSetExtract, request.local.javaHome);
        const universal = path.join(apkSetExtract, 'universal.apk');
        const derived = await inspectApk(universal, request, 'aab-derived-universal.apk', true);
        diagnostics.push(...derived.diagnostics);
        inspected.push({
          kind: 'aab',
          size,
          signature: bundleSignature,
          bundletool: 'passed',
          derivedSignature: derived.signature,
          nativeLibraries: derived.nativeLibraries,
        });
      } catch (error) {
        diagnostics.push(
          diagnostic(
            'android-bundletool-verification-failed',
            artifact.path,
            `AAB could not produce a valid APK set: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        inspected.push({ kind: 'aab', size, bundletool: 'failed' });
      }
    }
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    apkSetPath,
    verification: {
      status: diagnostics.length ? 'failed' : 'passed',
      inspected,
      abi: request.deployment.android?.abi,
      packageSha256: request.packageSha256,
      deviceLaunchRan: false,
    },
  };
}
