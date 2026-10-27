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
    shutil.copytree(binary.parent / 'assets/system', root / 'assets/system')
    runner_name = 'noveltea-ui-test-runner.exe' if os.name == 'nt' else 'noveltea-ui-test-runner'
    shutil.copy2(binary.parent / runner_name, root / runner_name)
    environment = {**os.environ, 'PATH': str(root), 'NOVELTEA_NO_DAEMON': '1'}

    def run(*args, cwd=root, timeout=60, input_text=None):
        return subprocess.run([str(installed), *args], cwd=cwd, env=environment,
                              capture_output=True, text=True, timeout=timeout, input=input_text)

    def envelope(*args, code=0, cwd=root, timeout=60):
        result = run('--json', *args, cwd=cwd, timeout=timeout)
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
    project_commands = {
        'validate', 'fmt', 'project create', 'project import', 'project export',
        'entity inspect', 'entity create', 'entity rename', 'entity delete',
        'usages', 'asset audit', 'asset import', 'localization sync',
        'localization view', 'localization reconcile', 'localization accept',
        'localization review', 'shaders compile', 'shaderc', 'texturec',
        'test run', 'test run-spec', 'test run-ui-spec', 'package export',
        'agent sync', 'media-tool check', 'daemon status', 'daemon stop',
        'comfyui status', 'comfyui workflows', 'comfyui verify',
    }
    assert project_commands <= public_paths
    claimed_platform = {'comfyui run', 'platform profiles', 'platform export',
                        'platform template list', 'platform template inspect',
                        'platform template install', 'platform template remove',
                        'platform config init'}
    for command in public_paths - project_commands - claimed_platform:
        assert envelope(*command.split(), code=70)['diagnostics'][0]['code'] == 'CLI_NATIVE_CANDIDATE_UNCLAIMED'

    # One realistic authored fixture, then a small native-created Project for
    # repeated relocated/negative checks (avoid repeatedly parsing Feature Lab).
    feature_lab = source / 'tests/projects/feature-lab'
    feature = envelope('--project', str(feature_lab), 'entity', 'inspect', 'rooms',
                       'active-text-finish')
    assert feature['record']['label'] == 'Notice acknowledged'
    assert feature['record']['data']['anchors'] == []

    created = root / 'created'
    new = envelope('project', 'create', str(created), '--name', 'Native CLI Test')
    assert new['projectRoot'] == str(created)
    assert (created / 'project.yaml').is_file()
    # Shader compilation is a real standalone C++ command, including its
    # variant parser and the native Project/source-generation admission path.
    shader = envelope('--project', str(created), 'shaders', 'compile', '--variant', 'glsl-330')
    assert shader['native']['ok'] and shader['native']['success']
    assert shader['native']['outputs'] == []
    assert envelope('--project', str(created), 'shaders', 'compile',
                    '--variant', 'invalid', code=2)['diagnostics'][0]['message'] == (
                        "Unknown shader variant 'invalid'.")
    assert envelope('--project', str(created), 'shaders', 'compile',
                    '--force-rebuild', '--force-rebuild', code=2)['diagnostics'][0]['message'] == (
                        "Option '--force-rebuild' may be supplied only once.")
    assert envelope('shaderc', code=2)['diagnostics'][0]['message'] == (
        "Raw 'shaderc' does not support NovelTea --json mode.")
    assert envelope('texturec', code=2)['diagnostics'][0]['message'] == (
        "Raw 'texturec' does not support NovelTea --json mode.")
    for command in [('test', 'run', 'first', 'second'),
                    ('test', 'run-spec', '--wrong'),
                    ('test', 'run-ui-spec', 'unexpected')]:
        assert envelope(*command, code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'
    missing_input = run('--json', '--project', str(created), 'test', 'run-spec',
                        input_text='')
    assert missing_input.returncode == 2
    assert json.loads(missing_input.stdout)['diagnostics'][0]['code'] == 'CLI_USAGE'
    malformed_input = run('--json', '--project', str(created), 'test', 'run-ui-spec',
                          input_text='{broken')
    assert malformed_input.returncode == 2
    assert json.loads(malformed_input.stdout)['diagnostics'][0]['code'] == 'CLI_USAGE'
    # With a sealed compiler identity the native CLI now admits a cold Project
    # and reports its genuine missing-entrypoint compiler failure. Unsealed
    # candidates still reject runtime commands before Project admission.
    for command in [('test', 'run'), ('test', 'run', 'unknown')]:
        raw = run('--json', '--project', str(created), *command)
        assert raw.stderr == '', raw.stderr
        unprepared = json.loads(raw.stdout)
        assert raw.returncode == unprepared['exitCode'] in (4, 70), unprepared
        assert any(d['code'] in ('CLI_NATIVE_RUNTIME_COMPILER_UNBOUND',
                                 'native.runtime.preparation')
                   for d in unprepared['diagnostics']), unprepared
    assert envelope('--project', str(created), 'package', 'export', code=2)[
        'diagnostics'][0]['message'] == "package export requires '--output <path>'."
    missing_package = run('--json', '--project', str(created), 'package', 'export',
                          '--output', str(root / 'no-package.ntpkg'))
    assert missing_package.stderr == '', missing_package.stderr
    missing_result = json.loads(missing_package.stdout)
    assert missing_package.returncode == missing_result['exitCode'] in (4, 70)
    assert any(d['code'] in ('CLI_NATIVE_RUNTIME_COMPILER_UNBOUND',
                             'native.runtime.preparation') for d in missing_result['diagnostics'])
    envelope('--project', str(created), 'entity', 'create', 'rooms', 'witness-room')
    project = created
    inspect = ['entity', 'inspect', 'rooms', 'witness-room']
    value = envelope('--no-daemon', '--project', str(project), *inspect)
    assert value['collection'] == 'rooms' and value['id'] == 'witness-room'
    assert value['record']['data']['anchors'] == []
    assert envelope(*inspect, cwd=project / 'records/rooms') == value
    assert envelope('--project', '.', *inspect, cwd=project) == value
    assert envelope(*inspect, cwd=project) == value
    assert envelope('--project', str(project), *inspect) == value
    usages = envelope('--project', str(project), 'usages', 'rooms', 'witness-room')
    assert usages['collection'] == 'rooms' and usages['id'] == 'witness-room'
    assert isinstance(usages['usages'], list)
    audit = envelope('--project', str(project), 'asset', 'audit')
    assert audit['projectRoot'] == str(project)
    for args, expected in [
        (['entity', 'rename', 'rooms', 'one'], 'Usage: noveltea entity rename'),
        (['localization', 'view'], 'Usage: noveltea localization view'),
        (['asset', 'import'], 'Usage: noveltea asset import'),
        (['project', 'create'], 'Project directory is required.'),
        (['fmt', '--wat'], 'Usage: noveltea fmt'),
    ]:
        failure = envelope(*args, code=2)
        assert failure['diagnostics'][0]['message'].startswith(expected)

    proven = envelope('--project', str(project), *inspect, '--provenance')
    assert proven['provenance']['label'] == 'explicit'
    assert proven['provenance']['data']['anchors'] == 'default'
    human = run('--project', str(project), *inspect)
    assert human.returncode == 0 and json.loads(human.stdout) == value['record']
    missing = envelope('--project', str(root), *inspect, code=3)
    assert missing['diagnostics'][0]['code'] == 'WORKSPACE_NOT_FOUND'
    absent = envelope('--project', str(project), 'entity', 'inspect', 'rooms', 'absent-room', code=4)
    assert absent['diagnostics'][0]['code'] == 'authoring.entity.not_found'
    damaged = root / 'project with spaces'
    shutil.copytree(project, damaged, ignore=shutil.ignore_patterns('.noveltea'))
    selected = ['--project', str(damaged), *inspect]
    assert envelope(*selected)['record'] == value['record']
    record = damaged / 'records/rooms/witness-room.yaml'
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
    assert envelope(*inspect, code=3, cwd=damaged / 'records')['projectRoot'] == str(damaged)

    # Relocated binary owns actual source writes, not just argument routing.
    missing_entrypoint = envelope('--project', str(created), 'validate', code=4)
    assert any(d['code'] == 'COMPILER_ENTRYPOINT_REQUIRED'
               for d in missing_entrypoint['diagnostics'])
    assert envelope('--project', str(created), 'fmt', '--check')['changed'] == 0
    assert envelope('--project', str(created), 'asset', 'audit')['untrackedFiles'] == []
    assert envelope('--project', str(created), 'localization', 'sync', '--dry-run')['dryRun']
    # The generated Project has only a source locale; view needs a target locale.
    view_failure = envelope('--project', str(created), 'localization', 'view', 'en', code=3)
    assert view_failure['diagnostics'][0]['code'] == 'WORKSPACE_SOURCE_READ'
    plan = envelope('--project', str(created), 'entity', 'create', 'rooms',
                    'first-room', '--dry-run')
    assert plan['dryRun'] and plan['plan']['writes']
    entity_file = created / 'records/rooms/first-room.yaml'
    assert not entity_file.exists()
    assert envelope('--project', str(created), 'entity', 'create', 'rooms',
                    'first-room')['plan'] == plan['plan']
    assert entity_file.is_file()
    rename = envelope('--project', str(created), 'entity', 'rename', 'rooms',
                      'first-room', 'second-room', '--dry-run')
    assert rename['fromId'] == 'first-room' and rename['dryRun']
    assert entity_file.is_file()
    envelope('--project', str(created), 'entity', 'rename', 'rooms', 'first-room', 'second-room')
    assert not entity_file.exists()
    renamed = created / 'records/rooms/second-room.yaml'
    assert renamed.is_file()
    envelope('--project', str(created), 'entity', 'delete', 'rooms', 'second-room', '--dry-run')
    assert renamed.is_file()
    envelope('--project', str(created), 'entity', 'delete', 'rooms', 'second-room')
    assert not renamed.exists()
    source_image = source / 'tests/projects/feature-lab/assets/images/ui-pattern.png'
    planned_asset = envelope('--project', str(created), 'asset', 'import',
                             str(source_image), '--dry-run')
    assert planned_asset['dryRun'] and not planned_asset['assets'][0]['alreadyImported']
    asset_file = created / planned_asset['assets'][0]['projectRelativePath']
    assert not asset_file.exists()
    committed_asset = envelope('--project', str(created), 'asset', 'import', str(source_image))
    assert committed_asset['assets'][0]['assetId'] == planned_asset['assets'][0]['assetId']
    assert asset_file.is_file()
    # An already registered in-Project source is recognized without writing;
    # re-importing an external original is intentionally a distinct import.
    repeated_asset = envelope('--project', str(created), 'asset', 'import',
                              str(asset_file), '--dry-run')
    assert repeated_asset['assets'][0]['alreadyImported']
    archive = root / 'portable.ntproject'
    bundle = envelope('--project', str(created), 'project', 'export', '--output', str(archive))
    assert bundle['outputPath'] == str(archive) and archive.is_file()
    imported = envelope('project', 'import', str(archive), str(root / 'imported'))
    assert Path(imported['projectFilePath']).is_file()
    assert Path(imported['projectFilePath']).read_bytes() == (created / 'project.yaml').read_bytes()
    print('Native CLI physical mutation, lifecycle and validation contracts passed.')

    # Font coverage is a public validation contract, not only static YAML admission.
    coverage_root = root / 'font-coverage'
    envelope('project', 'create', str(coverage_root), '--name', 'Native Font Coverage')
    envelope('--project', str(coverage_root), 'entity', 'create', 'rooms', 'sample-room')
    (coverage_root / 'project.yaml').open('a', encoding='utf-8').write(
        '\nentrypoint:\n  kind: room\n  id: sample-room\n')
    message_file = coverage_root / 'i18n/messages.yaml'
    message_file.write_text(message_file.read_text().replace(
        'messages: {}',
        'messages:\n  17111111-1111-4111-8111-111111111111:\n'
        '    kind: named\n    key: coverage.test\n    source: "珍"'))
    with (coverage_root / 'i18n/project.yaml').open('a', encoding='utf-8') as file:
        file.write('  fr:\n    supported: true\n    parentLocale: null\n    fontStack: null\n')
    uncovered = envelope('--project', str(coverage_root), 'validate', code=6)
    gaps = [d for d in uncovered['diagnostics'] if d['code'] == 'localization.font_coverage']
    assert {d['message'].split("Locale '", 1)[1].split("'", 1)[0] for d in gaps} == {'en', 'fr'}
    assert all(d['path'] ==
               '/localization/messages/17111111-1111-4111-8111-111111111111/source'
               for d in gaps)
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(coverage_root),
             'validate'], cwd=root, env=environment, capture_output=True, text=True, timeout=60)
        assert reference.returncode == 6
        assert uncovered == json.loads(reference.stdout)
    print('Native CLI font coverage validation matches production.')

    notices = root / 'missing-notice'
    shutil.copytree(created, notices, ignore=shutil.ignore_patterns('.noveltea'))
    manifest = notices / 'project.yaml'
    manifest.write_text(manifest.read_text().replace(
        'distributionNotices: []',
        'distributionNotices:\n    - path: notes/DOESNOTEXIST.md'))
    missing_notice = envelope('--project', str(notices), 'validate', code=4)
    assert missing_notice['diagnostics'][0]['code'] == 'WORKSPACE_SOURCE_READ'
    assert 'Portable Project source is missing: notes/DOESNOTEXIST.md' in (
        missing_notice['diagnostics'][0]['message'])
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(notices), 'validate'],
            cwd=root, env=environment, capture_output=True, text=True, timeout=60)
        assert reference.returncode == 4
        assert missing_notice == json.loads(reference.stdout)
    notice_file = notices / 'notes/DOESNOTEXIST.md'
    notice_file.parent.mkdir(parents=True)
    notice_file.write_text('')
    empty_notice = envelope('--project', str(notices), 'validate', code=4)
    assert any(d['code'] == 'authoring.distribution-notice.invalid' and
               'empty, too large, or contains prohibited controls' in d['message']
               for d in empty_notice['diagnostics'])
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(notices), 'validate'],
            cwd=root, env=environment, capture_output=True, text=True, timeout=60)
        assert reference.returncode == 4
        assert empty_notice == json.loads(reference.stdout)
    notice_file.write_bytes(b'Invalid encoding: \xff\xfe')
    invalid_utf8_notice = envelope('--project', str(notices), 'validate', code=4)
    assert any(d['code'] == 'authoring.distribution-notice.invalid' and
               'missing, unsafe, or invalid UTF-8' in d['message']
               for d in invalid_utf8_notice['diagnostics'])
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(notices), 'validate'],
            cwd=root, env=environment, capture_output=True, text=True, timeout=60)
        assert reference.returncode == 4
        assert invalid_utf8_notice == json.loads(reference.stdout)
    notice_file.write_bytes(b'Prohibited control: \x01')
    control_notice = envelope('--project', str(notices), 'validate', code=4)
    assert any(d['code'] == 'authoring.distribution-notice.invalid' and
               'contains prohibited controls' in d['message']
               for d in control_notice['diagnostics'])
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(notices), 'validate'],
            cwd=root, env=environment, capture_output=True, text=True, timeout=60)
        assert reference.returncode == 4
        assert control_notice == json.loads(reference.stdout)

    # The embedded shader compiler can print annotated failed source directly
    # to process stdout. The public relocated native CLI must still emit one
    # strict JSON response with the exact production diagnostics, and shared
    # shader requests must be compiled only once.
    shader_root = root / 'shader-invalid'
    shutil.copytree(feature_lab, shader_root, ignore=shutil.ignore_patterns('.noveltea'))
    shader_file = shader_root / 'shaders/engine2d-draw-contract.fs.sc'
    source_text = shader_file.read_text()
    assert 'uniform vec4 u_strength;' in source_text
    shader_file.write_text(source_text.replace('uniform vec4 u_strength;',
                                               'uniform vec3 u_strength;'))
    invalid_shader = envelope('--project', str(shader_root), 'validate', code=6, timeout=180)
    shader_errors = [d for d in invalid_shader['diagnostics']
                     if d['code'] == 'native.shader.contract_violation']
    assert len(shader_errors) == 1
    assert shader_errors[0]['message'].startswith("Author Material uniform 'u_strength'")
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(shader_root),
             'validate'], cwd=root, env=environment, capture_output=True, text=True, timeout=180)
        assert reference.returncode == 6
        assert invalid_shader == json.loads(reference.stdout)
    print('Native CLI shader-compiler error parity and strict JSON passed.')

    # A successful compile can still change a Material's reflected interface.
    # The same shared program may belong to several Materials with distinct
    # authored overrides; each must retain its own warning and source owner.
    shader_file.write_text(source_text.replace('uniform vec4 u_strength;', '')
                           .replace('u_strength.x', '0.25'))
    orphaned = envelope('--project', str(shader_root), 'validate', timeout=180)
    orphan_warnings = [d for d in orphaned['diagnostics']
                       if d['code'] == 'shader.material_project']
    assert len(orphan_warnings) == 3
    assert all('is not present in the reflected shader interface and remains orphaned.'
               in d['message'] for d in orphan_warnings)
    if len(sys.argv) > 3:
        reference = subprocess.run(
            [str(Path(sys.argv[3]).resolve()), '--json', '--project', str(shader_root),
             'validate'], cwd=root, env=environment, capture_output=True, text=True, timeout=180)
        assert reference.returncode == 0
        assert orphaned == json.loads(reference.stdout)
    print('Native CLI reflected Material warnings match production.')

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
            ['--json', '--project', str(created), 'validate'],
            ['--json', '--project', str(created), 'fmt', '--check'],
            ['--json', '--project', str(created), 'asset', 'audit'],
            ['--json', '--project', str(created), 'localization', 'sync', '--dry-run'],
            ['--json', '--project', str(created), 'localization', 'view', 'en'],
            ['--json', '--project', str(created), 'localization', 'reconcile'],
            ['--json', '--project', str(created), 'usages', 'rooms', 'missing-room'],
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
