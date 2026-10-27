"""Certify a real Web player archive through the installed native CLI.

Usage: web_release_smoke.py <native-cli> <template-zip> <repository> <output> <threaded|single> <base-path>
The template is supplied by the CI build; no release binaries are checked in.
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
import zipfile
import zlib


cli, archive, repository, output = map(lambda value: Path(value).resolve(), sys.argv[1:5])
threaded = sys.argv[5] == 'threaded'
assert sys.argv[5] in ('threaded', 'single')
base = sys.argv[6]
assert base.startswith('/') and base.endswith('/')


def icon():
    def chunk(kind, body):
        return (struct.pack('>I', len(body)) + kind + body +
                struct.pack('>I', zlib.crc32(kind + body)))

    pixel = b'\x00\x23\x33\x99\xff'
    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(pixel)) + chunk(b'IEND', b''))


with tempfile.TemporaryDirectory(prefix='noveltea-native-web-release-') as temporary:
    root = Path(temporary)
    project = root / 'project'
    shutil.copytree(repository / 'tests/fixtures/native-platform-export-web', project)
    for name in ('app-icon', 'backdrop', 'backdrop-fr'):
        image = project / 'assets/images' / f'{name}.png'
        image.parent.mkdir(parents=True, exist_ok=True)
        image.write_bytes(icon())
    for name in ('body', 'alternate'):
        font = project / 'assets/fonts' / f'{name}.ttf'
        font.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(repository / 'engine/assets/system/fonts/LiberationSans.ttf', font)
    audio = project / 'assets/audio/theme.wav'
    audio.parent.mkdir(parents=True, exist_ok=True)
    audio.write_bytes(b'RIFF' + struct.pack('<I', 36) + b'WAVEfmt ' +
                      struct.pack('<IHHIIHH', 16, 1, 1, 8000, 16000, 2, 16) +
                      b'data' + struct.pack('<I', 0))
    script = project / 'assets/scripts/startup.lua'
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text('fixture_started = true\n')

    with zipfile.ZipFile(archive) as template:
        descriptor_file = next(name for name in template.namelist()
                               if name == 'template.json' or name.endswith('/template.json'))
        descriptor = json.loads(template.read(descriptor_file))
    assert descriptor['platform'] == 'web' and descriptor['architecture'] == 'wasm32'
    features = descriptor['compiledFeatures']
    assert ('web-threads' if threaded else 'web-single-threaded') in features
    manifest = project / 'project.yaml'
    source = manifest.read_text()
    source = source.replace('buildFlavor: debug', f"buildFlavor: {descriptor['buildFlavor']}")
    if not threaded:
        source = source.replace('threaded: true', 'threaded: false')
    source = source.replace('basePath: /\n', f'basePath: {base}\n')
    manifest.write_text(source)

    env = {**os.environ, 'NOVELTEA_TEMPLATE_REGISTRY_ROOT': str(root / 'templates'),
           'NOVELTEA_USER_CONFIG_ROOT': str(root / 'config'), 'HOME': str(root)}

    def invoke(*args):
        command = [str(cli), '--json', *map(str, args)]
        process = subprocess.run(command, cwd=root, env=env, capture_output=True,
                                 text=True, timeout=300)
        assert process.stdout, (command, process.stderr)
        response = json.loads(process.stdout)
        assert response['success'] and process.returncode == 0, (command, response)
        return response

    installed = invoke('platform', 'template', 'install', archive)
    arguments = ('--project', project, 'platform', 'export', '--profile', 'canonical-web',
                 '--template', installed['id'], '--output', output, '--allow-untrusted-template',
                 '--allow-localization-warnings')
    invoke(*arguments, '--check')
    assert not output.exists() and not (project / '.noveltea/build').exists()
    published = invoke(*arguments)
    assert published['signingApplied'] is False
    files = json.loads((output / 'export-manifest.json').read_text())['files']
    for entry in files:
        contents = (output / entry['path']).read_bytes()
        assert len(contents) == entry['size']
        assert hashlib.sha256(contents).hexdigest() == entry['sha256']
    player = json.loads((output / 'player.json').read_text())
    assert player['package']['sha256'] == hashlib.sha256(
        (output / player['package']['path']).read_bytes()).hexdigest()
    web_manifest = json.loads((output / 'manifest.webmanifest').read_text())
    assert web_manifest['start_url'] == web_manifest['scope'] == base
    assert all((output / item['src'].removeprefix(base)).is_file()
               for item in web_manifest['icons'])
    assert (output / 'service-worker.js').is_file()
    headers = (output / 'DEPLOYMENT.md').read_text()
    assert ('Cross-Origin-Embedder-Policy: require-corp' in headers) == threaded
    with zipfile.ZipFile(str(output) + '.zip') as packed:
        assert set(packed.namelist()) == {item['path'] for item in files} | {
            'export-manifest.json'}
        for entry in files:
            assert packed.read(entry['path']) == (output / entry['path']).read_bytes()

    evidence = output.parent / (output.name + '-native-evidence.json')
    evidence.write_text(json.dumps({
        'template': archive.name, 'threaded': threaded, 'basePath': base,
        'templateToken': installed['id'], 'fileCount': len(files),
        'publicationReadback': True, 'archiveReadback': True,
    }, indent=2) + '\n')
    print(f'Native Web export verified: {len(files)} files at {base}; threaded: {threaded}')
