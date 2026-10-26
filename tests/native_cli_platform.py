"""Exercise C++ platform/template commands through an installed native CLI."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile


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
