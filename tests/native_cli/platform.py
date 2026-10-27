"""Exercise C++ platform/template commands through an installed native CLI."""
import hashlib
import json
import os
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


def sha(data):
    return hashlib.sha256(data).hexdigest()


with tempfile.TemporaryDirectory(prefix='noveltea-native-platform-') as temporary:
    root = Path(temporary)
    installed = root / binary.name
    shutil.copy2(binary, installed)
    environment = {**os.environ, 'NOVELTEA_TEMPLATE_REGISTRY_ROOT': str(root / 'templates'),
                   'NOVELTEA_USER_CONFIG_ROOT': str(root / 'user-config'), 'HOME': str(root)}

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
                   'role': 'notice' if name.startswith('licenses/') else 'player'}
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
    win_descriptor = dict(descriptor)
    win_descriptor.update(templateId='test-win', platform='windows', architecture='x64',
                          shaderVariants=['glsl-330'], graphicsBackends=['d3d11'],
                          packageAccessModes=['sidecar'])
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
            'command': 'signtool', 'args': [],
            'verifyCommand': 'signtool', 'verifyArgs': []}]}}))
    assert run(*win_req, '--signing-profile', 'unknown', code=4)[
        'diagnostics'][0]['code'] == 'platform.signing_profile_required'
    assert run(*win_req, '--signing-profile', 'desktop', code=70)[
        'diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'
    assert run(*win_req, '--sign', code=70)[
        'diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'
    stored = json.loads(user_config_file.read_text())
    stored['export']['signingProfiles'].append({
        'id': 'second', 'label': 'Second signer', 'target': 'windows',
        'command': 'signtool', 'args': [],
        'verifyCommand': 'signtool', 'verifyArgs': []})
    user_config_file.write_text(json.dumps(stored))
    assert run(*win_req, '--sign', code=4)['diagnostics'][0]['code'] == (
        'platform.signing_profile_required')
    assert run(*win_req, '--signing-profile', 'desktop', code=70)[
        'diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'
    configured.write_text(json.dumps({
        'format': 'noveltea.editor-export-local-state',
        'toolchains': {'javaHome': '/unused/jdk'},
        'signing': {'windows': {
            'command': 'signtool', 'args': [],
            'verifyCommand': 'signtool', 'verifyArgs': [],
        }},
    }))
    assert run(*win_req, '--config', configured, '--sign', code=70)[
        'diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'
    user_config_file.unlink()
    assert run('platform', 'template', 'remove', 'test-win@v1', '--force')['removed']

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
    assert run(*requested, '--allow-untrusted-template', code=70)[
        'diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'
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
    print('Native platform template, config, and scoped profiles contracts passed.')
