"""Certify actual Linux release-template exports through the direct C++ CLI.

Only ephemeral copies of the template and Project are used. The test boots
both the portable launcher and opt-in AppImage from unrelated working directories.
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
import zlib


cli, archive, repository = (Path(p).resolve() for p in sys.argv[1:4])
evidence_path = Path(sys.argv[4]).resolve() if len(sys.argv) > 4 else None


def pixel():
    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body +
                struct.pack('>I', zlib.crc32(kind + body)))

    raw = b'\x00\x23\x33\x99\xff'
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def launch(path, cwd, environment):
    proc = subprocess.Popen([str(path)], cwd=cwd, env=environment,
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        time.sleep(5)
        if proc.poll() is not None:
            assert proc.returncode == 0, (path, proc.returncode, proc.stderr.read())
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
    return proc.returncode


with tempfile.TemporaryDirectory(prefix='noveltea-native-linux-release-') as temporary:
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

    with tarfile.open(archive, 'r:gz') as source:
        descriptor_name = next(name for name in source.getnames()
                               if name == 'template.json' or name.endswith('/template.json'))
        descriptor = json.loads(source.extractfile(descriptor_name).read())
    assert descriptor['platform'] == 'linux' and descriptor['architecture'] == 'x64'
    original = (project / 'project.yaml').read_text()
    original = original.replace('id: canonical-web', 'id: canonical-linux')
    original = original.replace('buildFlavor: debug',
                                'buildFlavor: ' + descriptor['buildFlavor'])
    original = original.replace(
        '      target: web\n      architecture: wasm32\n'
        '      packageAccess: web-fetch\n      web:\n'
        '        artifact: directory-zip\n        threaded: true\n'
        '        pwa: true\n        display: standalone\n'
        '        basePath: /\n        serviceWorker: offline',
        '      target: linux\n      architecture: x64\n'
        '      packageAccess: sidecar\n      desktop:\n'
        '        artifact: tar\n        executableName: game')
    assert 'target: linux' in original and 'target: web' not in original
    (project / 'project.yaml').write_text(original)

    environment = {**os.environ, 'NOVELTEA_TEMPLATE_REGISTRY_ROOT': str(root / 'registry'),
                   'NOVELTEA_USER_CONFIG_ROOT': str(root / 'user'), 'HOME': str(root),
                   'NOVELTEA_PLAYER_HEADLESS_ERRORS': '1', 'APPIMAGE_EXTRACT_AND_RUN': '1'}

    def invoke(*args):
        command = [str(cli), '--json', *map(str, args)]
        completed = subprocess.run(command, cwd=root, env=environment, capture_output=True,
                                   text=True, timeout=240)
        assert completed.stdout, (command, completed.stderr)
        data = json.loads(completed.stdout)
        assert completed.returncode == 0 and data['success'], (command, data)
        return data

    token = invoke('platform', 'template', 'install', archive)['id']
    output = root / 'export'
    args = ('--project', project, 'platform', 'export', '--profile', 'canonical-linux',
            '--template', token, '--output', output,
            '--allow-untrusted-template', '--allow-localization-warnings')
    assert invoke(*args, '--check')['success']
    assert not output.exists()
    published = invoke(*args)
    assert published['deployment']['target'] == 'linux'
    launcher = output / 'game'
    assert launcher.is_file() and launcher.stat().st_mode & 0o111
    assert (output / 'bin/game.ntpkg').is_file()
    assert (output / 'bin/player.json').is_file()
    assert len(list((output / 'share/icons/hicolor').glob('*/apps/*.png'))) >= 4
    assert list((output / 'share/applications').glob('*.desktop'))
    metadata = json.loads((output / 'LINUX_METADATA.json').read_text())
    elf = output / metadata['player']
    assert elf.read_bytes()[:5] == b'\x7fELF\x02' and elf.stat().st_mode & 0o111
    manifest = json.loads((output / 'export-manifest.json').read_text())
    pathnames = {item['path'] for item in manifest['files']} | {'export-manifest.json'}
    with tarfile.open(str(output) + '.tar.gz', 'r:gz') as packaged:
        assert set(packaged.getnames()) == pathnames
        for item in manifest['files']:
            content = (output / item['path']).read_bytes()
            assert len(content) == item['size']
            assert hashlib.sha256(content).hexdigest() == item['sha256']
            assert packaged.extractfile(item['path']).read() == content
            assert packaged.getmember(item['path']).mode == item['mode'] & 0o777

    canonical_evidence = os.environ.get('NOVELTEA_CANONICAL_EVIDENCE_OUTPUT')
    if canonical_evidence:
        subprocess.run(['node', str(repository / 'scripts/native-canonical-export-evidence.mjs'),
                        '--archive', str(archive), '--export', str(output),
                        '--project', str(project), '--evidence', canonical_evidence], check=True)

    unrelated = root / 'unrelated-working-directory'
    unrelated.mkdir()
    directory_exit = launch(launcher, unrelated, environment)
    image_exit = None
    appimage_readback = False
    tool = environment.get('NOVELTEA_LINUX_APPIMAGE_TOOL')
    if tool:
        (project / 'project.yaml').write_text(original.replace('artifact: tar',
                                                               'artifact: appimage'))
        published_image = invoke(*args, '--force')
        image = Path(str(output) + '.AppImage')
        assert published_image['success'] and image.stat().st_mode & 0o111
        assert image.read_bytes()[:4] == b'\x7fELF'
        image_exit = launch(image, unrelated, environment)
        extracted = root / 'appimage-readback'
        extracted.mkdir()
        extraction = subprocess.run([str(image), '--appimage-extract'], cwd=extracted,
                                    env=environment, capture_output=True, text=True,
                                    timeout=120)
        assert extraction.returncode == 0, extraction.stderr
        appdir = extracted / 'squashfs-root'
        assert (appdir / 'AppRun').stat().st_mode & 0o111
        for item in manifest['files']:
            assert (appdir / item['path']).read_bytes() == (
                output / item['path']).read_bytes()
        appimage_readback = True
    if evidence_path:
        evidence_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_path.write_text(json.dumps({
            'target': 'linux-x64', 'cli': str(cli), 'template': archive.name,
            'templateToken': token, 'exported': True, 'archiveReadback': True,
            'directoryLaunch': True, 'appimageLaunch': image_exit is not None,
            'appimageReadback': appimage_readback,
            'directoryReturnCode': directory_exit, 'appimageReturnCode': image_exit,
            'files': len(manifest['files']), 'signed': False,
        }, indent=2) + '\n')
    print(f'C++ Linux release export verified: {len(manifest["files"])} files, '
          f'portable launch and AppImage={image_exit is not None}')
