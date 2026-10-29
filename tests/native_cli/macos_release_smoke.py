"""Certify a real macOS player template with the direct C++ platform exporter.

All Project, registry, and distribution paths are disposable. This is separate
from the established editor/TypeScript app-bundle release qualification.
"""

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
import time
import zipfile
import zlib


cli, archive, repository = (Path(item).resolve() for item in sys.argv[1:4])
evidence_path = Path(sys.argv[4]).resolve() if len(sys.argv) > 4 else None


def png():
    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body +
                struct.pack('>I', zlib.crc32(kind + body)))

    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(b'\x00\x23\x33\x99\xff')) +
            chunk(b'IEND', b''))


def check_launch(binary, directory, environment):
    process = subprocess.Popen([str(binary)], cwd=directory, env=environment,
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        time.sleep(5)
        if process.poll() is not None:
            assert process.returncode == 0, (
                'Native macOS player failed to start', process.returncode,
                process.stderr.read())
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


with tempfile.TemporaryDirectory(prefix='noveltea-native-macos-release-') as temporary:
    root = Path(temporary)
    project = root / 'project'
    shutil.copytree(repository / 'tests/fixtures/native-platform-export-web', project)
    for name in ('app-icon', 'backdrop', 'backdrop-fr'):
        image = project / 'assets/images' / f'{name}.png'
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(png())
    for name in ('body', 'alternate'):
        font = project / 'assets/fonts' / f'{name}.ttf'
        font.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repository / 'engine/assets/system/fonts/LiberationSans.ttf', font)
    audio = project / 'assets/audio/theme.wav'
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b'RIFF' + struct.pack('<I', 36) + b'WAVEfmt ' +
                      struct.pack('<IHHIIHH', 16, 1, 1, 8000, 16000, 2, 16) +
                      b'data' + struct.pack('<I', 0))
    startup = project / 'assets/scripts/startup.lua'
    startup.parent.mkdir(parents=True, exist_ok=True)
    startup.write_text('fixture_started = true\n')

    with tarfile.open(archive, 'r:gz') as source:
        descriptor_name = next(name for name in source.getnames()
                               if name == 'template.json' or name.endswith('/template.json'))
        descriptor = json.loads(source.extractfile(descriptor_name).read())
    assert descriptor['platform'] == 'macos' and descriptor['architecture'] == 'arm64'
    manifest_path = project / 'project.yaml'
    manifest = manifest_path.read_text()
    manifest = manifest.replace('id: canonical-web', 'id: canonical-macos')
    manifest = manifest.replace('buildFlavor: debug',
                                'buildFlavor: ' + descriptor['buildFlavor'])
    source_profile = (
        '      target: web\n      architecture: wasm32\n'
        '      packageAccess: web-fetch\n      web:\n'
        '        artifact: directory-zip\n        threaded: true\n'
        '        pwa: true\n        display: standalone\n'
        '        basePath: /\n        serviceWorker: offline'
    )
    target_profile = (
        '      target: macos\n      architecture: arm64\n'
        '      packageAccess: bundle-resource\n      desktop:\n'
        '        artifact: app-bundle\n        executableName: game'
    )
    assert source_profile in manifest, 'The current-format Project fixture changed.'
    manifest = manifest.replace(source_profile, target_profile)
    manifest_path.write_text(manifest)

    environment = {
        **os.environ,
        'NOVELTEA_TEMPLATE_REGISTRY_ROOT': str(root / 'registry'),
        'NOVELTEA_USER_CONFIG_ROOT': str(root / 'user'),
        'HOME': str(root),
        'NOVELTEA_PLAYER_HEADLESS_ERRORS': '1',
    }

    def invoke(*args):
        # This lane certifies the native C++ exporter itself. Keep the
        # platform publication in the invoking process rather than routing
        # through the separate daemon/disposable-worker certification path.
        command = [str(cli), '--no-daemon', '--json', *map(str, args)]
        done = subprocess.run(command, cwd=root, env=environment, capture_output=True,
                              text=True, timeout=240)
        assert done.stdout, (command, done.stderr)
        response = json.loads(done.stdout)
        assert done.returncode == 0 and response['success'], (command, response, done.stderr)
        return response

    token = invoke('platform', 'template', 'install', archive)['id']
    output = root / 'Tea Fixture.app'
    arguments = ('--project', project, 'platform', 'export', '--profile',
                 'canonical-macos', '--template', token, '--output', output,
                 '--allow-untrusted-template', '--allow-localization-warnings')
    assert invoke(*arguments, '--check')['success']
    assert not output.exists(), 'Read-only macOS export check published a bundle.'
    published = invoke(*arguments)
    assert published['deployment']['target'] == 'macos'
    assert not published['signingApplied']
    executable = output / 'Contents/MacOS/game'
    assert executable.is_file() and executable.stat().st_mode & 0o111
    assert (output / 'Contents/Resources/game.ntpkg').is_file()
    assert (output / 'Contents/Resources/player.json').is_file()
    assert (output / 'Contents/Resources/AppIcon.icns').read_bytes()[:4] == b'icns'
    info = output / 'Contents/Info.plist'
    assert info.is_file() and b'CFBundleIdentifier' in info.read_bytes()
    manifest_artifact = next(
        (item for item in published['artifacts'] if item['kind'] == 'manifest'), None)
    assert manifest_artifact is not None, published
    manifest_file = Path(manifest_artifact['path'])
    assert manifest_file == root / 'Tea Fixture-export-manifest.json', manifest_artifact
    assert manifest_file.is_file(), (manifest_artifact, sorted(p.name for p in root.iterdir()))
    manifest = json.loads(manifest_file.read_text())
    assert manifest['deployment']['target'] == 'macos'
    files = {item['path']: item for item in manifest['files']}
    assert files and 'Contents/MacOS/game' in files
    with zipfile.ZipFile(root / 'Tea Fixture.zip') as zipped:
        assert zipped.testzip() is None
        assert set(zipped.namelist()) == {f'{output.name}/{name}' for name in files}
        for name, item in files.items():
            data = (output / name).read_bytes()
            assert hashlib.sha256(data).hexdigest() == item['sha256']
            assert len(data) == item['size']
            assert zipped.read(f'{output.name}/{name}') == data

    canonical_evidence = os.environ.get('NOVELTEA_CANONICAL_EVIDENCE_OUTPUT')
    if canonical_evidence:
        subprocess.run(['node', str(repository / 'scripts/native-canonical-export-evidence.mjs'),
                        '--archive', str(archive), '--export', str(output),
                        '--project', str(project), '--evidence', canonical_evidence], check=True)

    unrelated = root / 'unrelated-working-directory'
    unrelated.mkdir()
    check_launch(executable, unrelated, environment)
    # LaunchServices must accept the assembled app too (not just a raw binary).
    opened = subprocess.run(['open', '-a', str(output)], cwd=unrelated,
                            capture_output=True, text=True, timeout=30)
    assert opened.returncode == 0, opened.stderr
    # LaunchServices detaches its application process from the 'open' client.
    # Do not leave it running when the disposable app bundle is replaced.
    subprocess.run(['pkill', '-f', str(executable)], capture_output=True, check=False)

    dmg_export = invoke(*arguments, '--force', '--dmg')
    assert any(item['kind'] == 'dmg' for item in dmg_export['artifacts'])
    dmg = root / 'Tea Fixture.dmg'
    assert dmg.is_file()
    subprocess.run(['hdiutil', 'verify', str(dmg)], check=True, capture_output=True,
                   timeout=120)

    # Ad-hoc signing tests the real host codesign/verify hooks without a
    # production developer identity, Apple credentials, or notarization.
    config_path = root / 'signing-config.json'
    invoke('platform', 'config', 'init', config_path)
    configuration = json.loads(config_path.read_text())
    configuration['signing'] = {'macos': {'identity': '-'}}
    config_path.write_text(json.dumps(configuration, indent=2) + '\n')
    signed = invoke(*arguments, '--force', '--sign', '--config', config_path)
    assert signed['signingApplied']
    assert not dmg.exists(), 'Disabled DMG must retire the prior DMG.'
    assert (root / 'Tea Fixture-signing-report.json').is_file()
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(output)],
                   check=True, capture_output=True)
    assert (output / 'Contents/_CodeSignature/CodeResources').is_file()
    assert manifest_file.is_file(), 'Signed macOS export lost its manifest sidecar.'
    manifest = json.loads(manifest_file.read_text())
    assert any('CodeSignature' in item['path'] for item in manifest['files'])
    check_launch(output / 'Contents/MacOS/game', unrelated, environment)

    # A later unsigned --force must retire the now-obsolete signing report.
    invoke(*arguments, '--force')
    assert not (root / 'Tea Fixture-signing-report.json').exists()
    assert not list(root.glob('Tea Fixture.app.previous-*'))
    assert not list(root.glob('Tea Fixture.app.noveltea-publication-transaction.json'))
    if evidence_path:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps({
            'target': 'macos-arm64',
            'template': archive.name,
            'templateToken': token,
            'nativeUnsignedBundle': True,
            'bundleZipReadback': True,
            'directLaunch': True,
            'launchServicesLaunch': True,
            'adHocCodesignVerified': True,
            'signingReportRetired': True,
            'dmgGeneratedAndVerified': True,
            'dmgRetired': True,
            'productionNotarization': False,
            'files': len(files),
        }, indent=2) + '\n')
    print(f'Native macOS release export certified: {len(files)} files, '
          'direct/LaunchServices launch, ad-hoc signing/verification, rollback-safe retirement.')
