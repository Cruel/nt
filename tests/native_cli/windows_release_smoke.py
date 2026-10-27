"""Exercise a real release Windows player template through the C++ platform CLI.

The template archive is an explicit input. This test never retains a copy of
the release player or depends on a checked-in binary fixture.
"""

import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import zipfile
import zlib


cli, archive, repository = map(lambda p: Path(p).resolve(), sys.argv[1:4])
evidence_path = Path(sys.argv[4]).resolve() if len(sys.argv) > 4 else None


def pixel():
    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body +
                struct.pack('>I', zlib.crc32(kind + body)))

    raw = b'\x00\x23\x33\x99\xff'
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


with tempfile.TemporaryDirectory(prefix='noveltea-native-windows-release-') as temporary:
    root = Path(temporary)
    project = root / 'project'
    shutil.copytree(repository / 'tests/fixtures/native-platform-export-web', project)
    for name in ('app-icon', 'backdrop', 'backdrop-fr'):
        image = project / 'assets/images' / f'{name}.png'
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(pixel())
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

    manifest = project / 'project.yaml'
    source = manifest.read_text()
    with zipfile.ZipFile(archive) as template_zip:
        descriptor_name = next(name for name in template_zip.namelist()
                               if name == 'template.json' or name.endswith('/template.json'))
        release = json.loads(template_zip.read(descriptor_name))['buildFlavor'] == 'release'
    source = source.replace('id: canonical-web', 'id: canonical-windows')
    source = source.replace('buildFlavor: debug',
                            'buildFlavor: release' if release else 'buildFlavor: debug')
    source = source.replace(
        '      target: web\n      architecture: wasm32\n'
        '      packageAccess: web-fetch\n      web:\n'
        '        artifact: directory-zip\n        threaded: true\n'
        '        pwa: true\n        display: standalone\n'
        '        basePath: /\n        serviceWorker: offline',
        '      target: windows\n      architecture: x64\n'
        '      packageAccess: sidecar\n      desktop:\n'
        '        artifact: zip\n        executableName: game',
    )
    assert 'id: canonical-windows' in source and 'target: windows' in source
    assert 'target: web' not in source
    manifest.write_text(source)

    env = {**os.environ, 'NOVELTEA_TEMPLATE_REGISTRY_ROOT': str(root / 'registry'),
           'NOVELTEA_USER_CONFIG_ROOT': str(root / 'user'), 'HOME': str(root)}

    def invoke(*args):
        command = [str(cli), '--json', *map(str, args)]
        process = subprocess.run(command, cwd=root, env=env, capture_output=True,
                                 text=True, timeout=240)
        assert process.stdout, (command, process.stderr)
        response = json.loads(process.stdout)
        assert process.returncode == 0 and response['success'], (command, response)
        return response

    installed = invoke('platform', 'template', 'install', archive)
    token = installed['id']
    output = root / 'export'
    args = ('--project', project, 'platform', 'export', '--profile',
            'canonical-windows', '--template', token, '--output', output,
            '--allow-untrusted-template', '--allow-localization-warnings')
    assert invoke(*args, '--check')['signingApplied'] is False
    published = invoke(*args)
    assert published['signingApplied'] is False
    exe = output / 'game.exe'
    assert exe.is_file()
    assert (output / 'game.ntpkg').is_file()
    assert (output / 'icons/windows/app.ico').is_file()
    manifest = json.loads((output / 'export-manifest.json').read_text())
    for item in manifest['files']:
        content = (output / item['path']).read_bytes()
        assert len(content) == item['size']
        assert hashlib.sha256(content).hexdigest() == item['sha256']
    packaged = Path(str(output) + '.zip')
    with zipfile.ZipFile(packaged) as reader:
        assert reader.testzip() is None
        for item in manifest['files']:
            assert reader.read(item['path']) == (output / item['path']).read_bytes()

    launched = None
    if os.name == 'nt':
        unrelated = root / 'unrelated-working-directory'
        unrelated.mkdir()
        launched = subprocess.Popen([str(exe)], cwd=unrelated,
                                    env={**env, 'NOVELTEA_PLAYER_HEADLESS_ERRORS': '1'},
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            time.sleep(5)
            if launched.poll() is not None:
                assert launched.returncode == 0, ('Windows game boot failed', launched.returncode)
        finally:
            if launched.poll() is None:
                launched.terminate()
                try:
                    launched.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    launched.kill()
                    launched.wait(timeout=10)

    if evidence_path:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps({
            'target': 'windows-x64', 'cli': str(cli), 'template': archive.name,
            'templateToken': token, 'exported': True, 'archiveReadback': True,
            'launchedOnWindows': os.name == 'nt',
            'launchReturnCode': launched.returncode if launched else None,
            'files': len(manifest['files']), 'signed': False,
        }, indent=2) + '\n')
    print(f'C++ Windows export verified: {len(manifest["files"])} files, '
          f'Windows launch: {os.name == "nt"}')
