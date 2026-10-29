"""Exercise C++ platform/template commands through an installed native CLI."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import zlib

if os.name == 'posix':
    import fcntl


binary = Path(sys.argv[1]).resolve()
source = Path(sys.argv[2]).resolve()
pe_fixture_generator = Path(sys.argv[3]).resolve() if len(sys.argv) > 3 else None


def sha(data):
    return hashlib.sha256(data).hexdigest()


with tempfile.TemporaryDirectory(prefix='noveltea-native-platform-') as temporary:
    root = Path(temporary)
    installed = root / binary.name
    shutil.copy2(binary, installed)
    environment = {**os.environ, 'NOVELTEA_TEMPLATE_REGISTRY_ROOT': str(root / 'templates'),
                   'NOVELTEA_USER_CONFIG_ROOT': str(root / 'user-config'), 'HOME': str(root),
                   'NOVELTEA_CLI_CERTIFICATION': '1',
                   'NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT': str(root / 'daemon')}

    def run(*args, code=0, cwd=root):
        process = subprocess.run([str(installed), '--json', *map(str, args)], cwd=cwd,
                                 env=environment, capture_output=True, text=True, timeout=90)
        assert process.returncode == code, (args, process)
        assert not process.stderr, process.stderr
        data = json.loads(process.stdout)
        assert data['exitCode'] == code and data['success'] == (code == 0), data
        return data

    assert run('platform', 'template', 'list')['templates'] == []
    assert run('platform', 'template', 'inspect', 'sample@v1', code=4)['diagnostics'][0]['code'] == 'platform.template_missing'
    for args in [('platform', 'template', 'remove', 'sample@v1'),
                 ('platform', 'template', 'install'),
                 ('platform', 'template', 'inspect', '../../evil'),
                 ('platform', 'config', 'init')]:
        assert run(*args, code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'

    configuration = root / 'settings.json'
    config = run('platform', 'config', 'init', configuration)
    assert config['config'] == json.loads(configuration.read_text())
    assert run('platform', 'config', 'init', configuration, code=4)['success'] is False
    first_bytes = configuration.read_bytes()
    assert run('platform', 'config', 'init', configuration, '--force')['success']
    assert first_bytes == configuration.read_bytes()
    configuration.unlink()
    configuration.symlink_to(root / 'absent')
    assert run('platform', 'config', 'init', configuration, '--force', code=4)['success'] is False
    assert configuration.is_symlink()

    project = root / 'project'
    run('project', 'create', project, '--name', 'Platform Command Fixture')
    profiles = run('--project', project, 'platform', 'profiles')
    assert profiles['profiles'] == [] and profiles['projectRoot'] == str(project)
    assert run('--project', project, 'platform', 'template', 'list', code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'

    staging = root / 'source'
    staging.mkdir()
    entries = {
        'licenses/fixture--mit.txt': b'MIT License\nA fixture notice\n',
        'player.js': b'globalThis.Module = {};\n',
        'player.wasm': b'\0asm\x01\0\0\0',
        'player.data': b'fixture Emscripten assets\n',
    }
    index = {'format': 'noveltea.engine-licenses', 'components': [{
        'component': 'fixture', 'displayName': 'Fixture', 'version': '1.0', 'files': [{
            'path': 'licenses/fixture--mit.txt',
            'size': len(entries['licenses/fixture--mit.txt']),
            'sha256': sha(entries['licenses/fixture--mit.txt'])}]}]}
    entries['licenses/index.json'] = (json.dumps(index) + '\n').encode()
    entries['SBOM.cdx.json'] = (json.dumps({'bomFormat': 'CycloneDX', 'components': [
        {'name': 'fixture', 'version': '1.0'}]}) + '\n').encode()
    for name, data in entries.items():
        output = staging / name
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(data)
    descriptor = {
        'format': 'noveltea.player-template', 'formatVersion': 1,
        'templateId': 'sample', 'buildId': 'v1', 'engineVersion': '0.1.0',
        'platform': 'web', 'architecture': 'wasm32', 'buildFlavor': 'debug',
        'minimumPlatformVersion': 'test', 'graphicsBackends': ['webgl2'],
        'shaderVariants': ['essl-300'], 'compiledProjectFormatVersion': 1,
        'playerRuntimeApiVersion': 1, 'compiledFeatures': ['web-single-threaded'],
        'capabilities': ['external-url'], 'packageAccessModes': ['web-fetch'],
        'files': [{'path': name, 'size': len(data), 'mode': 0o644, 'sha256': sha(data),
                   'role': 'notice' if name.startswith('licenses/') else
                           'player' if name == 'player.js' else 'support'}
                  for name, data in entries.items()],
        'runtimeDependencies': [{'path': name, 'kind': 'notice'}
                                for name in entries if name.startswith('licenses/')],
        'artifacts': {'archive': 'fixture.tar.gz', 'symbols': 'symbols.tar.gz',
                      'sbom': 'SBOM.cdx.json', 'notices': 'licenses/index.json'},
        'provenance': {'provider': 'local', 'source': 'fixture'},
        'host': {'assembly': 'any', 'requiresToolchain': False, 'tools': []},
    }
    (staging / 'template.json').write_text(json.dumps(descriptor))
    archive = root / 'fixture.tar.gz'
    with tarfile.open(archive, 'w:gz') as writer:
        for file in staging.rglob('*'):
            writer.add(file, arcname=file.relative_to(staging), recursive=False)
    created = run('platform', 'template', 'install', archive)
    assert created['entry']['trust'] == 'local-untrusted'
    expected = {'id': 'sample@v1', 'templateId': 'sample', 'buildId': 'v1', 'target': 'web',
                'architecture': 'wasm32', 'buildFlavor': 'debug', 'trust': 'local-untrusted',
                'status': 'untrusted'}
    assert run('platform', 'template', 'list')['templates'] == [expected]
    assert run('platform', 'template', 'inspect', 'sample@v1')['template'] == expected
    assert run('platform', 'template', 'install', archive, code=4)['diagnostics'][0]['code'] == 'template-install-failed'
    assert run('platform', 'template', 'install', archive, '--force')['success']

    zip_archive = root / 'fixture.zip'
    with zipfile.ZipFile(zip_archive, 'w') as writer:
        for file in staging.rglob('*'):
            if file.is_file():
                writer.write(file, arcname=file.relative_to(staging))
    assert run('platform', 'template', 'install', zip_archive, '--force')['success']

    # The complete export preflight stays write-free, including compiler/cache,
    # registry and output side effects. It uses the Project source fixture and
    # a separately synthesized template, not any release player archive.
    platform_project = root / 'web-project'
    shutil.copytree(source / 'tests/fixtures/native-platform-export-web', platform_project)
    def png_pixel(rgb):
        def chunk(kind, contents):
            return struct.pack('>I', len(contents)) + kind + contents + struct.pack(
                '>I', zlib.crc32(kind + contents))
        raw = b'\0' + bytes((*rgb, 255))
        return (b'\x89PNG\r\n\x1a\n' +
                chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
                chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))

    for name in ['app-icon', 'backdrop', 'backdrop-fr']:
        path = platform_project / 'assets/images' / f'{name}.png'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png_pixel((35, 51, 153)))
    for name in ['body', 'alternate']:
        path = platform_project / 'assets/fonts' / f'{name}.ttf'
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / 'engine/assets/system/fonts/LiberationSans.ttf', path)
    audio = platform_project / 'assets/audio/theme.wav'
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b'RIFF' + struct.pack('<I', 36) + b'WAVEfmt ' +
                      struct.pack('<IHHIIHH', 16, 1, 1, 8000, 16000, 2, 16) +
                      b'data' + struct.pack('<I', 0))
    script = platform_project / 'assets/scripts/startup.lua'
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text('fixture_started = true\n')
    manifest_file = platform_project / 'project.yaml'
    original_manifest = manifest_file.read_text()
    manifest_file.write_text(original_manifest.replace('threaded: true', 'threaded: false'))
    requested = ('--project', platform_project, 'platform', 'export',
                 '--profile', 'canonical-web', '--output', root / 'web-export',
                 '--template', 'sample@v1', '--allow-localization-warnings')
    assert run(*requested, '--check', code=4)['diagnostics'][0]['code'] == (
        'template-untrusted-acknowledgement-required')
    validated = run(*requested, '--check', '--allow-untrusted-template')
    assert validated['success'] and validated['signingApplied'] is False
    assert validated['templateToken'] == 'sample@v1'
    assert not (root / 'web-export.noveltea-publication.lock').exists()
    human = subprocess.run([str(installed), *map(str, requested), '--check',
                            '--allow-untrusted-template'], cwd=root, env=environment,
                           capture_output=True, text=True, timeout=90)
    assert human.returncode == 0, human
    assert '[validating]' in human.stderr and '[resolving-template]' in human.stderr, human
    assert 'preflight succeeded' in human.stdout, human
    assert not (root / 'web-export').exists()
    malformed_config = root / 'malformed-export-config.json'
    malformed_config.write_text(json.dumps({
        'format': 'noveltea.editor-export-local-state', 'toolchains': 42,
        'signing': 'invalid'}))
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--config', malformed_config, code=4)['diagnostics'][0]['code'] == (
                   'platform.config_invalid')
    malformed_config.write_text(json.dumps({
        'format': 'noveltea.editor-export-local-state', 'toolchains': {},
        'signing': {'windows': {'command': 'codesign', 'args': [],
                                'verifyCommand': 'verify', 'verifyArgs': []}}}))
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--config', malformed_config, '--sign', code=4)['diagnostics'][0]['code'] == (
                   'platform.signing_profile_required')

    # Existing TypeScript CLI interprets --config signing/toolchains as an
    # explicit local override, while templateRoots is an accepted editor-local
    # field (not a template registry override). These keys cannot cause an
    # unsigned Web preflight to fail with an arbitrary native exit 70.
    configured = root / 'export-config.json'
    configured.write_text(json.dumps({
        'format': 'noveltea.editor-export-local-state',
        'templateRoots': [str(root / 'unused-template-search-root')],
        'toolchains': {'javaHome': str(root / 'toolchain-not-used-by-web')},
        'signing': {'windows': {'command': 'signtool', 'args': [],
                                'verifyCommand': 'verify', 'verifyArgs': []}},
    }))
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--config', configured)['success']
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--config', configured, '--signing-profile', 'desktop', code=2)[
                   'diagnostics'][0]['code'] == 'CLI_USAGE'

    # Signed CLI options resolve the common ~/.noveltea/config.json profiles
    # before target-specific signing execution. A missing or mismatched named
    # profile is a semantic error, not a blanket unsupported-operation error.
    user_config_file = root / 'user-config/config.json'
    user_config_file.parent.mkdir(parents=True)
    user_config_file.write_text(json.dumps({
        'format': 'noveltea.user-config', 'formatVersion': 1,
        'export': {'toolchains': {'javaHome': '/unused/jdk'},
                   'signingProfiles': [{
                       'id': 'desktop', 'label': 'Desktop signer', 'target': 'windows',
                       'command': 'signtool', 'args': [],
                       'verifyCommand': 'signtool', 'verifyArgs': [],
                   }]},
    }))
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--signing-profile', 'absent', code=4)['diagnostics'][0]['code'] == (
                   'platform.signing_profile_required')
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--signing-profile', 'desktop', code=4)['diagnostics'][0]['code'] == (
                   'platform.signing_profile_required')
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--sign', code=4)['diagnostics'][0]['code'] == (
                   'platform.signing_profile_required')
    assert run(*requested, '--check', '--allow-untrusted-template')['success']
    # Malformed shared user config is treated as defaults, just like the
    # editor's config loader; malformed signer entries cannot be partly used.
    user_config_file.write_text('{invalid json')
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--signing-profile', 'desktop', code=4)['diagnostics'][0]['code'] == (
                   'platform.signing_profile_required')
    user_config_file.unlink()

    # A verified synthetic Windows template allows checking the shared signer
    # selection contract independently of the Windows PE/signing exporter.
    # Never rely on the large user-supplied player archive for this fixture.
    win_stage = root / 'win-template'
    shutil.copytree(staging, win_stage)
    if pe_fixture_generator:
        (win_stage / 'player.js').unlink()
        subprocess.run([str(pe_fixture_generator), '--emit-fixture',
                        str(win_stage / 'player.exe')], check=True)
    win_descriptor = dict(descriptor)
    win_descriptor.update(templateId='test-win', platform='windows', architecture='x64',
                          shaderVariants=['glsl-330'], graphicsBackends=['d3d11'],
                          packageAccessModes=['sidecar'], windowsImports=[])
    if pe_fixture_generator:
        win_descriptor['files'] = [entry for entry in win_descriptor['files']
                                   if entry['path'] != 'player.js']
        for entry in win_descriptor['files']:
            if entry['path'] == 'SBOM.cdx.json':
                entry['role'] = 'support'
        win_descriptor['files'].append({
            'path': 'player.exe', 'size': (win_stage / 'player.exe').stat().st_size,
            'mode': 0o755, 'sha256': sha((win_stage / 'player.exe').read_bytes()),
            'role': 'player'})
    (win_stage / 'template.json').write_text(json.dumps(win_descriptor))
    win_zip = root / 'test-win-template.zip'
    with zipfile.ZipFile(win_zip, 'w') as writer:
        for file in win_stage.rglob('*'):
            if file.is_file():
                writer.write(file, arcname=file.relative_to(win_stage))
    assert run('platform', 'template', 'install', win_zip)['success']
    win_project = root / 'windows-project'
    shutil.copytree(platform_project, win_project)
    win_manifest = win_project / 'project.yaml'
    win_yaml = win_manifest.read_text()
    win_yaml = win_yaml.replace('id: canonical-web', 'id: canonical-windows')
    win_yaml = win_yaml.replace('      target: web\n      architecture: wasm32\n'
                                '      packageAccess: web-fetch\n      web:\n'
                                '        artifact: directory-zip\n        threaded: false\n'
                                '        pwa: true\n        display: standalone\n'
                                '        basePath: /\n        serviceWorker: offline',
                                '      target: windows\n      architecture: x64\n'
                                '      packageAccess: sidecar\n      desktop:\n'
                                '        artifact: zip\n        executableName: game')
    win_manifest.write_text(win_yaml)
    win_req = ('--project', win_project, 'platform', 'export',
               '--profile', 'canonical-windows', '--output', root / 'win-output',
               '--template', 'test-win@v1', '--allow-untrusted-template',
               '--allow-localization-warnings', '--check')
    user_config_file.write_text(json.dumps({
        'format': 'noveltea.user-config', 'formatVersion': 1,
        'export': {'toolchains': {}, 'signingProfiles': [{
            'id': 'desktop', 'label': 'Windows signer', 'target': 'windows',
            'command': 'signtool', 'args': ['{subject}'],
            'verifyCommand': 'signtool', 'verifyArgs': ['{subject}']}]}}))
    assert run(*win_req, '--signing-profile', 'unknown', code=4)[
        'diagnostics'][0]['code'] == 'platform.signing_profile_required'
    assert run(*win_req, '--force', '--signing-profile', 'desktop')['success']
    assert run(*win_req, '--sign')['success']
    # A mutating invocation must pass the selected signer into common
    # staging, which rejects unsupported signing BEFORE any output or journal
    # is published. This is distinct from the --check-only rejection above.
    win_publish = tuple(part for part in win_req if part != '--check')
    if pe_fixture_generator:
        signer_script = root / 'mock-windows-signer.py'
        signer_script.write_text('''import pathlib, sys
subject = pathlib.Path(sys.argv[2])
if sys.argv[1] == 'sign':
    subject.write_bytes(subject.read_bytes() + b'MOCK-ONLY-SIGNED')
elif sys.argv[1] == 'verify':
    if not subject.read_bytes().endswith(b'MOCK-ONLY-SIGNED'):
        sys.exit(7)
elif sys.argv[1] == 'reject':
    sys.exit(7)
else:
    sys.exit(9)
''')
        user_signing = json.loads(user_config_file.read_text())
        test_signer = user_signing['export']['signingProfiles'][0]
        test_signer.update(command=sys.executable,
                           args=[str(signer_script), 'sign', '{subject}'],
                           verifyCommand=sys.executable,
                           verifyArgs=[str(signer_script), 'verify', '{subject}'])
        user_config_file.write_text(json.dumps(user_signing))
        signed = run(*win_publish, '--signing-profile', 'desktop')
        assert signed['signingRequested'] and signed['signingApplied']
        win_output = root / 'win-output'
        report = json.loads((win_output / 'SIGNING_REPORT.json').read_text())
        assert report['verified'] and report['signed']
        assert report['timestamped'] is None  # No trusted timestamp asserted by mock.
        exe = win_output / 'game.exe'
        assert exe.read_bytes().endswith(b'MOCK-ONLY-SIGNED')
        assert report['subjects'][0]['sha256'] == sha(exe.read_bytes())
        manifest = json.loads((win_output / 'export-manifest.json').read_text())
        assert next(f for f in manifest['files'] if f['path'] == 'game.exe')['sha256'] == (
            sha(exe.read_bytes()))
        assert not (root / 'win-output.noveltea-publication-transaction.json').exists()
        test_signer['verifyArgs'] = [str(signer_script), 'reject', '{subject}']
        user_config_file.write_text(json.dumps(user_signing))
        existing_hash = sha(exe.read_bytes())
        assert run(*win_publish, '--sign', '--force', code=4)['diagnostics'][0]['code'] == (
            'platform.signature_verification_failed')
        assert sha(exe.read_bytes()) == existing_hash  # No partial overwrite.
        test_signer['verifyArgs'] = []
        user_config_file.write_text(json.dumps(user_signing))
        assert run(*win_publish, '--sign', '--force', code=4)['diagnostics'][0]['code'] == (
            'platform.signing_configuration_invalid')
        assert sha(exe.read_bytes()) == existing_hash
        test_signer['verifyArgs'] = [str(signer_script), 'verify', '{subject}']
        user_config_file.write_text(json.dumps(user_signing))
    else:
        assert run(*win_publish, '--signing-profile', 'desktop', code=4)['success'] is False
    stored = json.loads(user_config_file.read_text())
    stored['export']['signingProfiles'].append({
        'id': 'second', 'label': 'Second signer', 'target': 'windows',
        'command': 'signtool', 'args': [],
        'verifyCommand': 'signtool', 'verifyArgs': []})
    user_config_file.write_text(json.dumps(stored))
    assert run(*win_req, '--sign', code=4)['diagnostics'][0]['code'] == (
        'platform.signing_profile_required')
    assert run(*win_req, '--force', '--signing-profile', 'desktop')['success']
    configured.write_text(json.dumps({
        'format': 'noveltea.editor-export-local-state',
        'toolchains': {'javaHome': '/unused/jdk'},
        'signing': {'windows': {
            'command': 'signtool', 'args': ['{subject}'],
            'verifyCommand': 'signtool', 'verifyArgs': ['{subject}'],
        }},
    }))
    assert run(*win_req, '--force', '--config', configured, '--sign')['success']
    user_config_file.unlink()
    assert run('platform', 'template', 'remove', 'test-win@v1', '--force')['removed']

    # Linux portable export is exercised through the installed native CLI with
    # freshly compiled ELF fixtures. Its NEEDED closure includes an actual
    # bundled shared object, not just an unverified metadata declaration.
    if sys.platform.startswith('linux') and shutil.which('cc') and shutil.which('readelf'):
        linux_stage = root / 'linux-template'
        (linux_stage / 'bin').mkdir(parents=True)
        shared = linux_stage / 'bin/libntfixture.so'
        compiled = subprocess.run(
            ['cc', '-x', 'c', '-shared', '-fPIC', '-Wl,-soname,libntfixture.so',
             '-o', str(shared), '-'], input='int nt_fixture(void) { return 0; }\n',
            text=True, capture_output=True)
        assert compiled.returncode == 0, compiled.stderr
        binary = linux_stage / 'bin/noveltea-player'
        compiled = subprocess.run(
            ['cc', '-x', 'c', '-Wl,-rpath,$ORIGIN', '-L', str(shared.parent),
             '-o', str(binary), '-', '-lntfixture'],
            input='extern int nt_fixture(void); int main(void) { return nt_fixture(); }\n',
            text=True, capture_output=True)
        assert compiled.returncode == 0, compiled.stderr
        dynamic = subprocess.check_output(['readelf', '-d', str(binary)], text=True)
        needed = re.findall(r'Shared library: \[([^]]+)\]', dynamic)
        rpaths = re.findall(r'Library (?:rpath|runpath): \[([^]]+)\]', dynamic)
        assert 'libntfixture.so' in needed and '$ORIGIN' in rpaths
        for name in ('licenses/fixture--mit.txt', 'licenses/index.json', 'SBOM.cdx.json'):
            path = linux_stage / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(entries[name])
        (linux_stage / 'symbols').mkdir()
        (linux_stage / 'symbols/noveltea-player.debug').write_bytes(b'debug fixture\n')
        linux_files = []
        for file in linux_stage.rglob('*'):
            if not file.is_file():
                continue
            path = file.relative_to(linux_stage).as_posix()
            role = ('player' if path == 'bin/noveltea-player' else
                    'symbol' if path.endswith('.debug') else
                    'notice' if path.startswith('licenses/') else 'support')
            linux_files.append({'path': path, 'size': file.stat().st_size,
                                'mode': file.stat().st_mode & 0o777,
                                'sha256': sha(file.read_bytes()), 'role': role})
        linux_descriptor = {
            **descriptor, 'templateId': 'test-linux', 'buildId': 'v1',
            'platform': 'linux', 'architecture': 'x64',
            'graphicsBackends': ['opengl'], 'shaderVariants': ['glsl-330'],
            'packageAccessModes': ['sidecar'], 'linuxNeeded': needed,
            'linuxRpaths': rpaths, 'files': linux_files,
            'runtimeDependencies': [
                {'path': 'bin/libntfixture.so', 'kind': 'library'},
                {'path': 'bin/noveltea-player', 'kind': 'library'},
                *[{'path': name, 'kind': 'notice'} for name in
                  ('licenses/fixture--mit.txt', 'licenses/index.json')],
            ],
        }
        (linux_stage / 'template.json').write_text(json.dumps(linux_descriptor))
        linux_tar = root / 'test-linux.tar.gz'
        with tarfile.open(linux_tar, 'w:gz') as writer:
            for file in linux_stage.rglob('*'):
                if file.is_file():
                    writer.add(file, arcname=file.relative_to(linux_stage))
        assert run('platform', 'template', 'install', linux_tar)['success']
        linux_project = root / 'linux-project'
        shutil.copytree(platform_project, linux_project)
        linux_yaml = (linux_project / 'project.yaml').read_text()
        linux_yaml = linux_yaml.replace('id: canonical-web', 'id: canonical-linux')
        linux_yaml = linux_yaml.replace(
            '      target: web\n      architecture: wasm32\n'
            '      packageAccess: web-fetch\n      web:\n'
            '        artifact: directory-zip\n        threaded: false\n'
            '        pwa: true\n        display: standalone\n'
            '        basePath: /\n        serviceWorker: offline',
            '      target: linux\n      architecture: x64\n'
            '      packageAccess: sidecar\n      desktop:\n'
            '        artifact: tar\n        executableName: game')
        assert 'target: linux' in linux_yaml and 'target: web' not in linux_yaml
        (linux_project / 'project.yaml').write_text(linux_yaml)
        linux_out = root / 'linux-output'
        linux_req = ('--project', linux_project, 'platform', 'export',
                     '--profile', 'canonical-linux', '--output', linux_out,
                     '--template', 'test-linux@v1', '--allow-untrusted-template',
                     '--allow-localization-warnings')
        assert run(*linux_req, '--check')['success']
        assert not linux_out.exists()
        exported = run(*linux_req)
        assert exported['success'] and exported['deployment']['target'] == 'linux'
        assert (linux_out / 'game').stat().st_mode & 0o111
        assert (linux_out / 'bin/game.ntpkg').is_file()
        assert (linux_out / 'bin/player.json').is_file()
        assert (linux_out / 'share/applications/org.example.noveltea.desktop').is_file() or list(
            (linux_out / 'share/applications').glob('*.desktop'))
        manifest = json.loads((linux_out / 'export-manifest.json').read_text())
        archive_path = Path(str(linux_out) + '.tar.gz')
        with tarfile.open(archive_path, 'r:gz') as archive_reader:
            archive_files = set(archive_reader.getnames())
            assert archive_files == {f['path'] for f in manifest['files']} | {
                'export-manifest.json'}
            for entry in manifest['files']:
                assert sha((linux_out / entry['path']).read_bytes()) == entry['sha256']
                assert archive_reader.extractfile(entry['path']).read() == (
                    linux_out / entry['path']).read_bytes()
        other_cwd = root / 'unrelated-linux-working-dir'
        other_cwd.mkdir()
        launched = subprocess.run([str(linux_out / 'game')], cwd=other_cwd,
                                  env={**environment, 'LD_LIBRARY_PATH': ''},
                                  capture_output=True, text=True, timeout=30)
        assert launched.returncode == 0, launched.stderr
        # Debug symbols are separately published, identified by the immutable
        # template build ID, and retired on the next symbols-disabled export.
        symbols_yaml = linux_yaml.replace('includeDebugSymbols: false',
                                          'includeDebugSymbols: true')
        (linux_project / 'project.yaml').write_text(symbols_yaml)
        with_symbols = run(*linux_req, '--force')
        symbols_path = Path(with_symbols['symbolArchivePath'])
        with tarfile.open(symbols_path, 'r:gz') as archive_reader:
            assert archive_reader.extractfile('BUILD_ID').read() == b'v1\n'
            assert archive_reader.extractfile('noveltea-player.debug').read() == (
                b'debug fixture\n')
        (linux_project / 'project.yaml').write_text(linux_yaml)
        assert run(*linux_req, '--force')['success']
        assert not symbols_path.exists()
        # ZIP is also a supported Linux artifact, independently of tar.gz.
        zip_yaml = linux_yaml.replace('artifact: tar', 'artifact: zip')
        (linux_project / 'project.yaml').write_text(zip_yaml)
        zip_req = tuple(str(argument).replace('linux-output', 'linux-zip-output')
                        for argument in linux_req)
        assert run(*zip_req)['success']
        with zipfile.ZipFile(root / 'linux-zip-output.zip') as archive_reader:
            assert archive_reader.testzip() is None
            assert archive_reader.read('bin/game.ntpkg') == (
                root / 'linux-zip-output/bin/game.ntpkg').read_bytes()
        (linux_project / 'project.yaml').write_text(linux_yaml)
        # No output replacement without --force, and rejected AppImage
        # creation must preserve the already published portable distribution.
        assert run(*linux_req, code=4)['diagnostics'][0]['code'] == 'platform-output-exists'
        available_appimage_tool = environment.get('NOVELTEA_LINUX_APPIMAGE_TOOL')
        environment['NOVELTEA_LINUX_APPIMAGE_TOOL'] = str(root / 'missing-appimagetool')
        image_yaml = linux_yaml.replace('artifact: tar', 'artifact: appimage')
        (linux_project / 'project.yaml').write_text(image_yaml)
        failed = run(*linux_req, '--force', code=4)
        assert not failed['success']
        assert archive_path.is_file() and (linux_out / 'game').is_file()
        if available_appimage_tool:
            environment['NOVELTEA_LINUX_APPIMAGE_TOOL'] = available_appimage_tool
            image = run(*linux_req, '--force')
            image_path = Path(str(linux_out) + '.AppImage')
            assert any(item['kind'] == 'appimage' for item in image['artifacts'])
            assert image_path.read_bytes()[:4] == b'\x7fELF'
            assert image_path.stat().st_mode & 0o111
            image_launch = subprocess.run([str(image_path)], cwd=other_cwd,
                                          env={**environment,
                                               'APPIMAGE_EXTRACT_AND_RUN': '1'},
                                          capture_output=True, text=True, timeout=30)
            assert image_launch.returncode == 0, image_launch.stderr
            extracted = root / 'appimage-readback'
            extracted.mkdir()
            extraction = subprocess.run([str(image_path), '--appimage-extract'],
                                        cwd=extracted, env=environment,
                                        capture_output=True, text=True, timeout=60)
            assert extraction.returncode == 0, extraction.stderr
            for file in manifest['files']:
                assert (extracted / 'squashfs-root' / file['path']).read_bytes() == (
                    linux_out / file['path']).read_bytes()
        else:
            environment.pop('NOVELTEA_LINUX_APPIMAGE_TOOL')
        (linux_project / 'project.yaml').write_text(linux_yaml)
        assert run(*linux_req, '--force')['success']
        assert not Path(str(linux_out) + '.AppImage').exists()
        # A newly installed template that lies about its ELF architecture is
        # rejected before it can replace a previously published distribution.
        bad_elf = bytearray(binary.read_bytes())
        bad_elf[18:20] = b'\xb7\x00'  # EM_AARCH64, invalid for x64 profile
        binary.write_bytes(bad_elf)
        for declared in linux_descriptor['files']:
            if declared['path'] == 'bin/noveltea-player':
                declared['sha256'] = sha(bad_elf)
        (linux_stage / 'template.json').write_text(json.dumps(linux_descriptor))
        bad_tar = root / 'wrong-architecture.tar.gz'
        with tarfile.open(bad_tar, 'w:gz') as writer:
            for file in linux_stage.rglob('*'):
                if file.is_file():
                    writer.add(file, arcname=file.relative_to(linux_stage))
        assert run('platform', 'template', 'install', bad_tar, '--force')['success']
        rejected = run(*linux_req, '--force', code=4)
        assert rejected['diagnostics'][0]['code'] == 'platform-staging-failed'
        assert 'x86_64 ELF' in rejected['diagnostics'][0]['message']
        assert (linux_out / 'game').is_file() and archive_path.is_file()
        assert run('platform', 'template', 'remove', 'test-linux@v1', '--force')['removed']

    # A reviewed-release French localization requiring review must be caught
    # by the write-free preflight, before package assembly.
    reviewed = manifest_file.read_text()
    manifest_file.write_text(reviewed.replace('quality: development',
                                               'quality: reviewed-release'))
    unacknowledged = tuple(part for part in requested if part != '--allow-localization-warnings')
    assert run(*unacknowledged, '--check', '--allow-untrusted-template', code=4)[
        'diagnostics'][0]['code'] == 'localization.export.warning_override_required'
    checked_reviewed = run(*requested, '--check', '--allow-untrusted-template')
    assert any(item['code'].startswith('localization.export.')
               for item in checked_reviewed['diagnostics'])
    assert any(item['code'] == 'localization.export.asset_needs_review'
               for item in checked_reviewed['diagnostics'])
    assert not (root / 'web-export').exists()
    assert not (platform_project / '.noveltea/build').exists()
    manifest_file.write_text(reviewed)
    assert not (platform_project / '.noveltea/build').exists()
    local = platform_project / '.noveltea/editor/state.json'
    local.parent.mkdir(parents=True, exist_ok=True)
    old_local = {
        'schema': 'noveltea.editor.local-state',
        'recovery': {'sequence': 3, 'saveUnitsById': {}},
        'sourceRecoveryById': {},
        'lastSuccessfulPlatformExportIdentity': {
            'applicationId': 'org.example.prior', 'saveNamespace': 'org.example.prior'},
    }
    local.write_text(json.dumps(old_local))
    assert run(*requested, '--check', '--allow-untrusted-template', code=4)[
        'diagnostics'][0]['code'] == 'platform.identity_change_acknowledgement_required'
    assert run(*requested, '--check', '--allow-untrusted-template',
               '--allow-identity-change')['success']
    assert json.loads(local.read_text()) == old_local
    local.unlink()
    assert run(*requested, '--check', '--allow-untrusted-template')['success']
    assert not (root / 'web-export').exists()
    (root / 'web-export').mkdir()
    assert run(*requested, '--check', '--allow-untrusted-template', code=4)[
        'diagnostics'][0]['code'] == 'platform-output-exists'
    assert run(*requested, '--check', '--allow-untrusted-template', '--force')['success']
    (root / 'web-export').rmdir()
    (root / 'web-export').symlink_to(root / 'nonexistent-output')
    assert run(*requested, '--check', '--allow-untrusted-template', '--force', code=4)[
        'diagnostics'][0]['code'] == 'platform-output-symlink-forbidden'
    (root / 'web-export').unlink()

    # Replacing a non-directory output or following a linked output parent is
    # never permitted, even when the user explicitly allows replacement.
    (root / 'web-export').write_text('not-a-directory')
    assert run(*requested, '--check', '--allow-untrusted-template', '--force', code=4)[
        'diagnostics'][0]['code'] == 'export.output_invalid'
    (root / 'web-export').unlink()
    (root / 'linked-parent').symlink_to(root, target_is_directory=True)
    linked_request = ('--project', platform_project, 'platform', 'export',
                      '--profile', 'canonical-web', '--output', root / 'linked-parent/web-export',
                      '--template', 'sample@v1')
    assert run(*linked_request, '--check', '--allow-untrusted-template', code=4)[
        'diagnostics'][0]['code'] == 'platform-output-symlink-forbidden'
    assert not (root / 'web-export').exists()
    # Even the recovery path must refuse a linked output parent before it
    # touches a pending transaction or any of its rollback backups.
    real_parent = root / 'real-parent'
    real_parent.mkdir()
    (root / 'recovery-link').symlink_to(real_parent, target_is_directory=True)
    real_output = real_parent / 'export'
    real_output.mkdir()
    (real_output / 'marker').write_text('new-build')
    pending_journal = real_parent / 'export.noveltea-publication-transaction.json'
    pending_journal.write_text(json.dumps({
        'format': 'noveltea.native-platform-publication', 'nonce': '123-456',
        'accepted': False, 'rollingBack': False,
        'outputs': [
            {'kind': 'directory', 'hadPrevious': True, 'removeOnly': False},
            {'kind': 'archive', 'hadPrevious': True, 'removeOnly': False},
        ]}))
    (real_parent / 'export.previous-123-456').mkdir()
    (real_parent / 'export.previous-123-456/marker').write_text('old-build')
    (real_parent / 'export.zip').write_bytes(b'new-archive')
    (real_parent / 'export.zip.previous-123-456').write_bytes(b'old-archive')
    linked_recovery = ('--project', platform_project, 'platform', 'export',
                       '--profile', 'canonical-web',
                       '--output', root / 'recovery-link/export', '--template', 'sample@v1',
                       '--allow-untrusted-template', '--allow-localization-warnings')
    assert run(*linked_recovery, '--force', code=4)['diagnostics'][0]['code'] == (
        'platform-output-symlink-forbidden')
    assert (real_output / 'marker').read_text() == 'new-build'
    assert pending_journal.exists()

    # Simulate a killed native publisher between artifact renames. --check
    # remains entirely read-only; the next mutating command restores the
    # previous complete distribution before considering new publication.
    old_output = root / 'web-export'
    old_archive = root / 'web-export.zip'
    old_output.mkdir()
    (old_output / 'marker').write_text('incumbent-directory')
    old_archive.write_bytes(b'incumbent-archive')
    nonce = '1234-5678'
    old_output.rename(root / f'web-export.previous-{nonce}')
    old_archive.rename(root / f'web-export.zip.previous-{nonce}')
    old_output.mkdir()
    (old_output / 'marker').write_text('interrupted-directory')
    (root / f'web-export.zip.stage-{nonce}').write_bytes(b'interrupted-archive')
    journal = root / 'web-export.noveltea-publication-transaction.json'
    journal.write_text(json.dumps({
        'format': 'noveltea.native-platform-publication',
        'nonce': nonce, 'accepted': False, 'rollingBack': False, 'outputs': [
            {'kind': 'directory', 'hadPrevious': True, 'removeOnly': False},
            {'kind': 'archive', 'hadPrevious': True, 'removeOnly': False},
        ],
    }))
    assert run(*requested, '--check', '--allow-untrusted-template', '--force', code=5)[
        'diagnostics'][0]['code'] == 'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT'
    assert (old_output / 'marker').read_text() == 'interrupted-directory'
    assert journal.exists()
    # A second independent CLI cannot recover an active publisher's journal.
    if os.name == 'posix':
        lock_file = root / 'web-export.noveltea-publication.lock'
        with lock_file.open('a+b') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            assert run(*requested, '--allow-untrusted-template', '--force', code=5)[
                'diagnostics'][0]['code'] == (
                'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT')
            assert journal.exists()
            assert (old_output / 'marker').read_text() == 'interrupted-directory'
            fcntl.flock(handle, fcntl.LOCK_UN)
    assert run(*requested, '--allow-untrusted-template', code=4)[
        'diagnostics'][0]['code'] == 'platform-output-exists'
    assert (old_output / 'marker').read_text() == 'incumbent-directory'
    assert old_archive.read_bytes() == b'incumbent-archive'
    assert not journal.exists()
    assert not (root / f'web-export.zip.stage-{nonce}').exists()

    # A symbols-retirement member never has a stage file. Recovery must
    # restore the entire previous distribution whether interruption occurred
    # just before or just after moving the obsolete symbols into its backup.
    symbols = root / 'web-export-symbols.zip'
    symbols_backup = root / f'web-export-symbols.zip.previous-{nonce}'
    for backup_taken in (False, True):
        old_output.rename(root / f'web-export.previous-{nonce}')
        old_archive.rename(root / f'web-export.zip.previous-{nonce}')
        old_output.mkdir()
        (old_output / 'marker').write_text('new-directory')
        old_archive.write_bytes(b'new-archive')
        if backup_taken:
            symbols_backup.write_bytes(b'incumbent-symbols')
        else:
            symbols.write_bytes(b'incumbent-symbols')
        journal.write_text(json.dumps({
            'format': 'noveltea.native-platform-publication', 'nonce': nonce,
            'accepted': False, 'rollingBack': False,
            'outputs': [
                {'kind': 'directory', 'hadPrevious': True, 'removeOnly': False},
                {'kind': 'archive', 'hadPrevious': True, 'removeOnly': False},
                {'kind': 'symbols', 'hadPrevious': True, 'removeOnly': True},
            ],
        }))
        assert run(*requested, '--check', '--allow-untrusted-template', '--force', code=5)[
            'diagnostics'][0]['code'] == 'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT'
        assert journal.exists()
        assert run(*requested, '--allow-untrusted-template', code=4)['diagnostics'][0][
            'code'] == 'platform-output-exists'
        assert (old_output / 'marker').read_text() == 'incumbent-directory'
        assert old_archive.read_bytes() == b'incumbent-archive'
        assert symbols.read_bytes() == b'incumbent-symbols'
        assert not symbols_backup.exists()
        assert not journal.exists()
        symbols.unlink()

    # If recovery evidence is irretrievably absent, preserve the journal
    # rather than declaring a partial or missing publication recovered.
    old_output.rename(root / f'web-export.previous-{nonce}')
    old_archive.rename(root / f'web-export.zip.previous-{nonce}')
    shutil.rmtree(root / f'web-export.previous-{nonce}')
    journal.write_text(json.dumps({
        'format': 'noveltea.native-platform-publication',
        'nonce': nonce, 'accepted': False, 'rollingBack': False, 'outputs': [
            {'kind': 'directory', 'hadPrevious': True, 'removeOnly': False},
            {'kind': 'archive', 'hadPrevious': True, 'removeOnly': False},
        ],
    }))
    assert run(*requested, '--allow-untrusted-template', '--force', code=5)[
        'diagnostics'][0]['code'] == 'WORKSPACE_TRANSACTION_RECOVERY_CONFLICT'
    assert journal.exists()

    # Native Web publication uses the existing transaction boundary; certify
    # a complete immutable browser artifact set and the independent ZIP readback.
    verified_output = root / 'verified-web'
    verified_request = tuple(verified_output if part == root / 'web-export' else part
                             for part in requested)
    web_export = run(*verified_request, '--allow-untrusted-template')
    assert web_export['success'] and not web_export['signingApplied']
    files = {entry['path']: entry for entry in json.loads(
        (verified_output / 'export-manifest.json').read_text())['files']}
    assert all(sha((verified_output / path).read_bytes()) == entry['sha256']
               for path, entry in files.items())
    assert all((verified_output / p).is_file() for p in [
        'index.html', 'manifest.webmanifest', 'player.json',
        'service-worker.js', 'DEPLOYMENT.md'])
    assert files['index.html']['origin'] == 'web-shell'
    assert json.loads((verified_output / 'export-manifest.json').read_text())[
        'deployment']['capabilityMetadata']['webRequirements'] == ['external-navigation']
    player = json.loads((verified_output / 'player.json').read_text())
    assert player['package']['path'].startswith('game.')
    assert player['package']['sha256'] == sha((verified_output / player['package']['path']).read_bytes())
    with zipfile.ZipFile(verified_output / player['package']['path']) as package:
        package_manifest = json.loads(package.read('manifest.json'))
        compiled_game = json.loads(package.read('game'))
        assert package_manifest['project'] == {
            'name': compiled_game['project']['name'],
            'version': compiled_game['project']['version'],
        }
        assert package_manifest['project']['version'] == '2026-10-09.1.1'
    html = (verified_output / 'index.html').read_text()
    for extension in ('.js', '.wasm', '.data'):
        name = next(path for path in files if path.startswith('player.')
                    and path.endswith(extension))
        assert name in html, (extension, name)
    assert 'NovelTeaPreviewBridge' in html and 'resolveWebPlayerSurfaceMetrics' in html
    web_manifest = json.loads((verified_output / 'manifest.webmanifest').read_text())
    assert web_manifest['start_url'] == '/' and len(web_manifest['icons']) == 2
    assert all((verified_output / icon['src'].lstrip('/')).is_file()
               for icon in web_manifest['icons'])
    assert 'Cross-origin isolation: not required' in (
        verified_output / 'DEPLOYMENT.md').read_text()
    with zipfile.ZipFile(root / 'verified-web.zip') as packed:
        assert set(packed.namelist()) == set(files) | {'export-manifest.json'}
        for path in files:
            assert packed.read(path) == (verified_output / path).read_bytes()
    initial_archive_sha = sha((root / 'verified-web.zip').read_bytes())
    assert run(*verified_request, '--allow-untrusted-template', code=4)[
        'diagnostics'][0]['code'] == 'platform-output-exists'
    assert run(*verified_request, '--allow-untrusted-template', '--force')['success']
    assert sha((root / 'verified-web.zip').read_bytes()) == initial_archive_sha
    assert not (root / 'verified-web.noveltea-publication-transaction.json').exists()

    # Failed replacement must retain the prior verified installation.
    malformed = root / 'invalid.zip'
    with zipfile.ZipFile(malformed, 'w') as writer:
        for file in staging.rglob('*'):
            if file.is_file():
                data = file.read_bytes()
                writer.writestr(str(file.relative_to(staging)),
                                b'tampered' if file.name == 'player.js' else data)
    assert run('platform', 'template', 'install', malformed, '--force', code=4)['diagnostics'][0]['code'] == 'template-install-failed'
    assert run('platform', 'template', 'inspect', 'sample@v1')['template'] == expected

    installed_notice = root / 'templates/sample/v1/licenses/fixture--mit.txt'
    installed_notice.write_text('tampered')
    assert run('platform', 'template', 'inspect', 'sample@v1')['template']['status'] == 'corrupted'
    assert run('platform', 'template', 'remove', 'sample@v1', '--force')['removed']
    assert run('platform', 'template', 'list')['templates'] == []
    assert run('platform', 'template', 'remove', 'sample@v1', '--force', code=4)['diagnostics'][0]['code'] == 'platform.template_missing'

    # The native profile projection must only report host compatibility when
    # a verified installed template satisfies the chosen target's shader and
    # threading requirements, rather than matching target/arch alone.
    feature_lab = source / 'tests/projects/feature-lab'
    before = run('--project', feature_lab, 'platform', 'profiles')['profiles']
    assert not next(row for row in before if row['id'] == 'web-threaded')['hostCompatible']
    descriptor.update(templateId='feature-web', buildId='cert', buildFlavor='release',
                      compiledFeatures=['web-threads'])
    (staging / 'template.json').write_text(json.dumps(descriptor))
    compatible_archive = root / 'compatible.tar.gz'
    with tarfile.open(compatible_archive, 'w:gz') as writer:
        for file in staging.rglob('*'):
            writer.add(file, arcname=file.relative_to(staging), recursive=False)
    assert run('platform', 'template', 'install', compatible_archive)['success']
    after = run('--project', feature_lab, 'platform', 'profiles')['profiles']
    assert next(row for row in after if row['id'] == 'web-threaded')['hostCompatible']

    # A template that requires Java/SDK/bundletool cannot be advertised as
    # zero-toolchain host compatible, but it must remain eligible for native
    # Android export. The export configuration then supplies those tools.
    android_descriptor = {
        **descriptor,
        'templateId': 'android-with-tools', 'buildId': 'cert',
        'platform': 'android', 'architecture': 'arm64',
        'packageAccessModes': ['android-private-copy'],
        'compiledFeatures': ['lua', 'rmlui', 'audio', 'save', 'android-private-copy'],
        'capabilities': ['external-url', 'vibration'],
        'host': {'assembly': 'any', 'requiresToolchain': True,
                 'tools': ['java', 'android-sdk', 'bundletool']},
        'android': {'supportedAbis': ['arm64-v8a'], 'artifactKinds': ['apk', 'aab'],
                    'packageAccessModes': ['android-private-copy'],
                    'minimumSdk': {'minimum': 24, 'maximum': 35}},
    }
    (staging / 'template.json').write_text(json.dumps(android_descriptor))
    android_archive = root / 'android-with-tools.tar.gz'
    with tarfile.open(android_archive, 'w:gz') as writer:
        for file in staging.rglob('*'):
            writer.add(file, arcname=file.relative_to(staging), recursive=False)
    assert run('platform', 'template', 'install', android_archive)['success']
    android_profiles = run('--project', feature_lab, 'platform', 'profiles')['profiles']
    assert not next(row for row in android_profiles if row['id'] == 'android')['hostCompatible']
    # Intentionally pass an absent config: reaching config validation proves
    # that native export accepted this template despite its tool requirements.
    android_export = run('--project', feature_lab, 'platform', 'export',
                         '--profile', 'android', '--template', 'android-with-tools@cert',
                         '--output', root / 'not-exported', '--allow-untrusted-template',
                         '--config', root / 'absent-android-config.json', code=4)
    assert android_export['diagnostics'][0]['code'] == 'platform.config_invalid', android_export

    unsafe = root / 'unsafe.tar.gz'
    with tarfile.open(unsafe, 'w:gz') as writer:
        symlink = tarfile.TarInfo('escape')
        symlink.type = tarfile.SYMTYPE
        symlink.linkname = '../somewhere'
        writer.addfile(symlink)
    assert run('platform', 'template', 'install', unsafe, code=4)['diagnostics'][0]['code'] == 'template-install-failed'
    assert not any((root / 'templates').glob('.install-*'))

    (root / 'templates/escape').symlink_to(root / 'outside', target_is_directory=True)
    assert run('platform', 'template', 'remove', 'escape@v1', '--force', code=4)['success'] is False
    assert (root / 'templates/escape').is_symlink()
    run('daemon', 'stop')
    print('Native platform template, config, and scoped profiles contracts passed.')
