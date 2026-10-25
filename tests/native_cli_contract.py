"""Exercise the unshipped C++ CLI only through a relocated public executable."""
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary, source = map(Path, sys.argv[1:3])
source = source.resolve()
help_text = (source / 'editor/src/cli/static-contracts.ts').read_text().split(
    'export const NOVELTEA_CLI_HELP = `', 1)[1].split('`;', 1)[0]
version = (source / 'VERSION').read_text().strip()

with tempfile.TemporaryDirectory(prefix='noveltea-native-cli-') as temporary:
    root = Path(temporary)
    installed = root / binary.name
    shutil.copy2(binary, installed)
    environment = {**os.environ, 'PATH': str(root), 'NOVELTEA_NO_DAEMON': '1'}

    def run(*args, cwd=root):
        return subprocess.run([str(installed), *args], cwd=cwd, env=environment,
                              capture_output=True, text=True, timeout=60)

    def envelope(*args, code=0, cwd=root):
        result = run('--json', *args, cwd=cwd)
        assert result.returncode == code, (args, result)
        assert result.stderr == '', result.stderr
        assert len(result.stdout.splitlines()) == 1, result.stdout
        value = json.loads(result.stdout)
        assert value['protocolVersion'] == 1
        assert value['exitCode'] == code
        assert value['success'] == (code == 0)
        return value

    result = run('--help')
    assert (result.returncode, result.stdout, result.stderr) == (0, help_text, '')
    assert envelope('--help')['help'] == help_text
    assert run('--version').stdout == version + '\n'
    assert envelope('--version')['version'] == version
    print('Native CLI relocated help/version contracts passed.')

    for args, message in [
        ([], 'A command is required.'),
        (['--wat'], "Unknown global option '--wat'."),
        (['--project'], "Global option '--project' requires a project directory."),
        (['--json'], "Global option '--json' may be supplied only once."),
        (['--no-daemon', '--no-daemon'], "Global option '--no-daemon' may be supplied only once."),
        (['--help', '--version'], '--help and --version cannot be combined.'),
        (['--help', 'validate'], '--help and --version do not accept a command path.'),
        (['bogus'], "Unknown command path 'bogus'."),
        (['entity', 'inspect', 'rooms'], 'Usage: noveltea entity inspect <collection> <id> [--provenance]'),
        (['entity', 'inspect', 'bogus', 'room'], "Unknown collection 'bogus'."),
        (['entity', 'inspect', 'rooms', '../room'], "Invalid record ID '../room'."),
    ]:
        value = envelope(*args, code=2)
        assert value['diagnostics'] == [dict(code='CLI_USAGE', severity='error', path='/', message=message)]
    bad = run('--wat')
    assert bad.returncode == 2 and bad.stdout == ''
    assert bad.stderr == "[error] CLI_USAGE /: Unknown global option '--wat'.\nUnknown global option '--wat'.\n\n" + help_text
    public_section = help_text.split('\nCommands:\n', 1)[1].split('\nGlobal options:\n', 1)[0]
    public_paths = set(re.findall(r'^  ([a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*)', public_section, re.MULTILINE))
    assert len(public_paths) == 39
    for command in public_paths - {'entity inspect'}:
        assert envelope(*command.split(), code=70)['diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'

    project = source / 'tests/projects/feature-lab'
    inspect = ['entity', 'inspect', 'rooms', 'active-text-finish']
    value = envelope('--no-daemon', '--project', str(project), *inspect)
    assert value['collection'] == 'rooms' and value['id'] == 'active-text-finish'
    assert value['record']['label'] == 'Notice acknowledged'
    assert value['record']['data']['anchors'] == []
    assert envelope(*inspect, cwd=project / 'records/rooms') == value
    assert envelope('--project', '.', *inspect, cwd=project) == value
    assert envelope(*inspect, cwd=project) == value
    assert envelope('--project', str(project), *inspect) == value
    proven = envelope('--project', str(project), *inspect, '--provenance')
    assert proven['provenance']['label'] == 'explicit'
    assert proven['provenance']['data']['anchors'] == 'default'
    human = run('--project', str(project), *inspect)
    assert human.returncode == 0 and json.loads(human.stdout) == value['record']
    assert '[info] hotspot.authoring.target.none' in human.stderr
    missing = envelope('--project', str(root), *inspect, code=3)
    assert missing['diagnostics'][0]['code'] == 'WORKSPACE_NOT_FOUND'
    absent = envelope('--project', str(project), 'entity', 'inspect', 'rooms', 'absent-room', code=4)
    assert absent['diagnostics'][0]['code'] == 'authoring.entity.not_found'
    damaged = root / 'project with spaces'
    shutil.copytree(project, damaged, ignore=shutil.ignore_patterns('.noveltea'))
    selected = ['--project', str(damaged), *inspect]
    assert envelope(*selected)['record'] == value['record']
    record = damaged / 'records/rooms/active-text-finish.yaml'
    original = record.read_bytes()
    record.write_text('id: [broken\n')
    malformed = envelope(*selected, code=3)
    assert any(item['code'] == 'WORKSPACE_SOURCE_READ' for item in malformed['diagnostics'])
    assert record.read_text() == 'id: [broken\n'
    record.write_bytes(original)
    assert envelope(*selected)['record'] == value['record']
    manifest = damaged / 'project.yaml'
    manifest.write_text(manifest.read_text().replace('schemaVersion: 1', 'schemaVersion: 999'))
    unsupported = envelope(*selected, code=3)
    assert any(item['code'] == 'WORKSPACE_VERSION_UNSUPPORTED' for item in unsupported['diagnostics'])
    # An invalid discovered manifest must not fall through to another Project.
    assert envelope(*inspect, code=3, cwd=damaged / 'records')['projectRoot'] == str(damaged)

    if len(sys.argv) > 3:
        oracle = Path(sys.argv[3]).resolve()
        cases = [
            ['--help'], ['--json', '--help'], ['--version'], ['--json', '--version'],
            ['--wat'], ['--json', '--wat'], ['--json', '--project'],
            ['--json', '--no-daemon', '--no-daemon'], ['--json', 'bogus'],
            ['--json', '--no-daemon', '--project', str(project), *inspect],
            ['--json', '--no-daemon', '--project', str(project), *inspect, '--provenance'],
            ['--no-daemon', '--project', str(project), *inspect],
            ['--json', '--project', str(project), 'entity', 'inspect', 'rooms', 'absent-room'],
            ['--json', *selected],
        ]
        for args in cases:
            native = run(*args)
            reference = subprocess.run([str(oracle), *args], cwd=root, env=environment,
                                       capture_output=True, text=True, timeout=60)
            assert native.returncode == reference.returncode, (args, native, reference)
            assert native.stderr == reference.stderr, (args, native.stderr, reference.stderr)
            if '--json' in args:
                assert json.loads(native.stdout) == json.loads(reference.stdout), (args, native.stdout, reference.stdout)
            else:
                assert native.stdout == reference.stdout, (args, native.stdout, reference.stdout)
        print(f'Installed production CLI differential passed: {len(cases)} cases.')
    print('Native CLI parsing, diagnostics and native Project inspection contracts passed.')
