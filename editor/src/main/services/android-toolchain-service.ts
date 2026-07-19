import path from 'node:path';
import { access, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export type AndroidToolName =
  | 'java'
  | 'gradle'
  | 'sdkmanager'
  | 'sdk-platform'
  | 'aapt2'
  | 'zipalign'
  | 'apksigner'
  | 'ndk-clang'
  | 'cmake'
  | 'bundletool'
  | 'adb';
export interface AndroidToolProbe {
  name: AndroidToolName;
  required: boolean;
  executable?: string;
  version?: string;
  ok: boolean;
  message?: string;
}
export interface AndroidToolchainProbeResult {
  ok: boolean;
  tools: AndroidToolProbe[];
  diagnostics: Array<{
    severity: 'warning' | 'error';
    code: string;
    path: string;
    message: string;
  }>;
}
export interface AndroidToolchainProbeRequest {
  javaHome?: string;
  androidSdk?: string;
  androidNdk?: string;
  cmake?: string;
  gradleWrapper?: string;
  bundletool?: string;
  compileSdk: number;
  buildToolsVersion: string;
  expectedVersions?: Partial<Record<AndroidToolName, string>>;
}

const executable = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
const runVersion = (command: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(new Error(output.trim() || `Exited with status ${code}.`)),
    );
  });

export async function probeAndroidToolchain(
  request: AndroidToolchainProbeRequest,
): Promise<AndroidToolchainProbeResult> {
  const sdk = request.androidSdk;
  const buildTools = sdk && path.join(sdk, 'build-tools', request.buildToolsVersion);
  let ndkVersion = '';
  if (request.androidNdk) {
    try {
      ndkVersion =
        /Pkg\.Revision\s*=\s*([^\r\n]+)/
          .exec(await readFile(path.join(request.androidNdk, 'source.properties'), 'utf8'))?.[1]
          ?.trim() ?? '';
    } catch {
      /* diagnosed through clang */
    }
  }
  let cmakeExecutable = request.cmake ?? executable('cmake');
  if (request.cmake) {
    try {
      if ((await stat(request.cmake)).isDirectory())
        cmakeExecutable = path.join(request.cmake, 'bin', executable('cmake'));
    } catch {
      /* diagnosed below */
    }
  }
  const candidates: Array<{
    name: AndroidToolName;
    required: boolean;
    file?: string;
    args?: string[];
    fixedVersion?: string;
  }> = [
    {
      name: 'java',
      required: true,
      file: request.javaHome
        ? path.join(request.javaHome, 'bin', executable('java'))
        : executable('java'),
      args: ['-version'],
    },
    { name: 'gradle', required: true, file: request.gradleWrapper, args: ['--version'] },
    {
      name: 'sdkmanager',
      required: false,
      file:
        sdk &&
        path.join(
          sdk,
          'cmdline-tools',
          'latest',
          'bin',
          process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager',
        ),
      args: ['--version'],
    },
    {
      name: 'sdk-platform',
      required: true,
      file: sdk && path.join(sdk, 'platforms', `android-${request.compileSdk}`, 'android.jar'),
      fixedVersion: String(request.compileSdk),
    },
    {
      name: 'aapt2',
      required: true,
      file: buildTools && path.join(buildTools, executable('aapt2')),
      fixedVersion: request.buildToolsVersion,
    },
    {
      name: 'zipalign',
      required: true,
      file: buildTools && path.join(buildTools, executable('zipalign')),
      fixedVersion: request.buildToolsVersion,
    },
    {
      name: 'apksigner',
      required: true,
      file:
        buildTools &&
        path.join(buildTools, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'),
      fixedVersion: request.buildToolsVersion,
    },
    {
      name: 'ndk-clang',
      required: true,
      file:
        request.androidNdk &&
        path.join(
          request.androidNdk,
          'toolchains',
          'llvm',
          'prebuilt',
          process.platform === 'win32'
            ? 'windows-x86_64'
            : process.platform === 'darwin'
              ? 'darwin-x86_64'
              : 'linux-x86_64',
          'bin',
          executable('clang'),
        ),
      fixedVersion: ndkVersion,
    },
    { name: 'cmake', required: true, file: cmakeExecutable, args: ['--version'] },
    {
      name: 'bundletool',
      required: true,
      file: request.bundletool,
      fixedVersion: path.basename(request.bundletool ?? ''),
    },
    {
      name: 'adb',
      required: false,
      file: sdk && path.join(sdk, 'platform-tools', executable('adb')),
      args: ['version'],
    },
  ];
  const tools: AndroidToolProbe[] = [];
  for (const candidate of candidates) {
    if (!candidate.file) {
      tools.push({
        name: candidate.name,
        required: candidate.required,
        ok: false,
        message: 'Location is not configured.',
      });
      continue;
    }
    try {
      if (candidate.file.includes(path.sep)) await access(candidate.file);
      const version =
        candidate.fixedVersion ?? (await runVersion(candidate.file, candidate.args ?? []));
      const expected = request.expectedVersions?.[candidate.name];
      if (expected && !version.toLocaleLowerCase().includes(expected.toLocaleLowerCase())) {
        tools.push({
          name: candidate.name,
          required: candidate.required,
          executable: candidate.file,
          version: version.split('\n')[0],
          ok: false,
          message: `Expected certified version '${expected}', found '${version.split('\n')[0]}'.`,
        });
      } else
        tools.push({
          name: candidate.name,
          required: candidate.required,
          executable: candidate.file,
          version: version.split('\n')[0],
          ok: true,
        });
    } catch (error) {
      tools.push({
        name: candidate.name,
        required: candidate.required,
        executable: candidate.file,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const diagnostics = tools
    .filter((tool) => !tool.ok)
    .map((tool) => ({
      severity: tool.required ? ('error' as const) : ('warning' as const),
      code: tool.required ? 'android-tool-required' : 'android-tool-optional',
      path: `/toolchain/${tool.name}`,
      message: `${tool.name} ${tool.required ? 'is required' : 'is unavailable (device smoke tests will be skipped)'}: ${tool.message}`,
    }));
  return { ok: !tools.some((tool) => tool.required && !tool.ok), tools, diagnostics };
}
