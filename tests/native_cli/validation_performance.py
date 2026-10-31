"""Manual native CLI daemon work/latency baseline; no CI stopwatch budgets.

Usage: python3 tests/native_cli/validation_performance.py <noveltea> <repo-root>

All projects, daemon state and source changes stay in a temporary directory.
Each JSON line records build identity, cache state, elapsed time and actual
native source/semantic work. The profile opts out of the broker exact-result
shortcut so an unchanged request reaches the resident native validator.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

binary = Path(sys.argv[1]).resolve()
source_root = Path(sys.argv[2]).resolve()
addon = source_root / "build/native-authoring-host/noveltea-authoring-node.node"
assert addon.is_file(), "Build noveltea-authoring-node for editor in-memory baselines"


def build_config(executable):
    for directory in executable.parents:
        cache = directory / 'CMakeCache.txt'
        if cache.is_file():
            fields = {}
            for line in cache.read_text().splitlines():
                if ':' in line and '=' in line and not line.startswith(('#', '//')):
                    key, rest = line.split(':', 1)
                    fields[key] = rest.partition('=')[2]
            return {
                'buildDirectory': str(directory),
                'buildType': fields.get('CMAKE_BUILD_TYPE', 'unknown'),
                'cxxCompiler': fields.get('CMAKE_CXX_COMPILER', 'unknown'),
                'cxxFlags': fields.get('CMAKE_CXX_FLAGS', ''),
            }
    raise AssertionError(f'Cannot determine CMake configuration for {executable}')


cli_config = build_config(binary)
addon_config = build_config(addon)

with tempfile.TemporaryDirectory(prefix='nt-validation-performance-') as temporary:
    root = Path(temporary)
    env = os.environ.copy()
    env.pop('NOVELTEA_NO_DAEMON', None)
    env.update(NOVELTEA_CLI_CERTIFICATION='1',
               NOVELTEA_VALIDATION_WORK_PROFILE='1',
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(root / 'daemon'))

    def invoke(*args, profile=True):
        request_env = env if profile else {
            key: value for key, value in env.items()
            if key != 'NOVELTEA_VALIDATION_WORK_PROFILE'
        }
        result = subprocess.run([str(binary), '--json', *map(str, args)],
                                env=request_env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        payload = json.loads(result.stdout)
        assert payload['success'] and not result.stderr, payload
        return payload

    def validate(project, state):
        started = time.perf_counter()
        response = invoke('--project', project, 'validate')
        duration = round((time.perf_counter() - started) * 1000, 2)
        work = response.get('validationWork')
        assert work is not None and 'endToEnd' in work, (
            'Build must support opt-in native validation work counters', response)
        signature = hashlib.sha256(json.dumps(
            response['diagnostics'], sort_keys=True).encode()).hexdigest()
        return {'state': state, 'ms': duration, 'work': work,
                'diagnosticDigest': signature}

    def print_result(size, samples):
        changed = [sample['ms'] for sample in samples if sample['state'] == 'warm-saved-label']
        print(json.dumps({
            'project': size,
            'binary': str(binary),
            'sourceCommit': subprocess.check_output(
                ['git', 'rev-parse', 'HEAD'], cwd=source_root, text=True).strip(),
            'workingTreeModified': bool(subprocess.check_output(
                ['git', 'status', '--porcelain', '--untracked-files=no'],
                cwd=source_root, text=True).strip()),
            'cliBuild': cli_config,
            'addon': str(addon),
            'addonBuild': addon_config,
            'cache': 'Native disk cache retained only for cached-restart; deleted for uncached-start',
            'samples': samples,
            'medianChangedMs': statistics.median(changed),
        }), flush=True)

    try:
        for size in ('feature-lab', 1, 101, 501):
            project = root / str(size)
            if size == 'feature-lab':
                shutil.copytree(source_root / 'tests/projects/feature-lab', project)
                room = project / 'records/rooms/feature-lab-home.yaml'
            else:
                invoke('project', 'create', project, '--name', 'Performance')
                invoke('--project', project, 'entity', 'create', 'rooms', 'performance')
                room = project / 'records/rooms/performance.yaml'
                original = room.read_text()
                for index in range(size - 1):
                    (room.parent / f'room-{index}.yaml').write_text(
                        original.replace('id: performance', f'id: room-{index}'))
                manifest = project / 'project.yaml'
                text = manifest.read_text()
                assert not re.search(r'^entrypoint:', text, re.M), text
                manifest.write_text(text + '\nentrypoint: { kind: room, id: performance }\n')

            # Project creation uses the same broker; reset it before baseline.
            invoke('daemon', 'stop')
            shutil.rmtree(project / '.noveltea/cache', ignore_errors=True)
            samples = [validate(project, 'uncached-start'),
                       validate(project, 'unchanged-resident')]
            assert samples[0]['work']['recheckedRecords'] > 1
            assert samples[1]['work']['recheckedRecords'] == 0
            assert samples[1]['work']['endToEnd']['sourceCaptures'] > 0
            assert samples[1]['work']['endToEnd']['contentHashes'] > 0
            if size == 1:
                standard = invoke('--project', project, 'validate', profile=False)
                assert 'validationWork' not in standard
                standard_digest = hashlib.sha256(json.dumps(
                    standard['diagnostics'], sort_keys=True).encode()).hexdigest()
                assert standard_digest == samples[1]['diagnosticDigest']
            original = room.read_text()
            match = re.search(r'^label: .*$', original, re.M)
            for index in range(3):
                replacement = f'label: Performance Bench {index}'
                room.write_text(original[:match.start()] + replacement +
                                original[match.end():] if match else
                                original + '\n' + replacement + '\n')
                measured = validate(project, 'warm-saved-label')
                assert measured['work']['recheckedRecords'] == 1
                assert measured['work']['endToEnd']['sourceCaptures'] > 0
                assert measured['diagnosticDigest'] == samples[0]['diagnosticDigest']
                samples.append(measured)

            invoke('daemon', 'stop')
            samples.append(validate(project, 'cached-restart'))
            assert samples[-1]['work']['recheckedRecords'] == 0
            invoke('daemon', 'stop')
            shutil.rmtree(project / '.noveltea/cache', ignore_errors=True)
            samples.append(validate(project, 'uncached-restart'))
            assert samples[-1]['work']['recheckedRecords'] == samples[0]['work']['recheckedRecords']

            if size == 'feature-lab':
                lua = project / 'records/layouts/feature-lab-hud/layout.lua'
                original_lua = lua.read_text()
                for index in range(3):
                    lua.write_text(original_lua + f'\n-- Validation bench {index}\n')
                    samples.append(validate(project, 'warm-saved-lua'))

            # The Node-API binding is the same native session used by Electron.
            # Run in a separate process so the disposable Project stays unchanged.
            editor = subprocess.run(
                ['node', str(source_root / 'editor/scripts/benchmark-native-working-validation.mjs'),
                 str(addon), str(project),
                 'feature-lab-home' if size == 'feature-lab' else 'performance'],
                cwd=source_root, capture_output=True, text=True, timeout=180)
            assert editor.returncode == 0, (editor.stdout, editor.stderr)
            samples.extend(json.loads(editor.stdout)['samples'])
            print_result(size, samples)
    finally:
        invoke('daemon', 'stop')
