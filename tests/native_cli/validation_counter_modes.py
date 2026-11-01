"""Counter build-option certification against two independent Release binaries.

Usage: python3 validation_counter_modes.py ON_CLI OFF_CLI REPO_ROOT
       [ON_ADDON OFF_ADDON]

Checks diagnostic/exit parity, runtime profiling availability, normal JSON
absence, editor working-session parity, and compiler-eliminated OFF recorders.
Measurements are informational, never machine-dependent assertions.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

if len(sys.argv) not in (4, 6):
    raise SystemExit(__doc__)
on_cli, off_cli, root = map(lambda x: Path(x).resolve(), sys.argv[1:4])
addons = list(map(lambda x: Path(x).resolve(), sys.argv[4:]))

with tempfile.TemporaryDirectory(prefix='nt-counter-modes-') as temporary:
    base = Path(temporary)
    project = base / 'source'
    env = {k: v for k, v in os.environ.items()
           if k not in ('NOVELTEA_VALIDATION_WORK_PROFILE', 'NOVELTEA_NO_DAEMON')}
    env['NOVELTEA_CLI_CERTIFICATION'] = '1'
    env['NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT'] = str(base / 'daemon')

    def invoke(binary, target, profile=False, daemon=False):
        run_env = dict(env)
        run_env['NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT'] = str(
            base / ('daemon-on' if binary == on_cli else 'daemon-off'))
        if profile:
            run_env['NOVELTEA_VALIDATION_WORK_PROFILE'] = '1'
        started = time.perf_counter()
        result = subprocess.run(
            [str(binary), '--json', *([] if daemon else ['--no-daemon']),
             '--project', str(target), 'validate'],
            env=run_env, capture_output=True, text=True, timeout=180)
        payload = json.loads(result.stdout)
        assert payload['exitCode'] == result.returncode, (result, payload)
        return payload, round((time.perf_counter() - started) * 1000, 2)

    def stop(binary):
        run_env = dict(env)
        run_env['NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT'] = str(
            base / ('daemon-on' if binary == on_cli else 'daemon-off'))
        result = subprocess.run([str(binary), '--json', 'daemon', 'stop'],
                                env=run_env, capture_output=True, text=True, timeout=40)
        assert result.returncode == 0, (result.stdout, result.stderr)

    create = subprocess.run(
        [str(on_cli), '--json', '--no-daemon', 'project', 'create', str(project),
         '--name', 'Counter mode parity'], env=env, capture_output=True, text=True)
    assert create.returncode == 0, (create.stdout, create.stderr)
    room = subprocess.run(
        [str(on_cli), '--json', '--no-daemon', '--project', str(project),
         'entity', 'create', 'rooms', 'entry'], env=env, capture_output=True, text=True)
    assert room.returncode == 0, (room.stdout, room.stderr)
    with (project / 'project.yaml').open('a') as manifest:
        manifest.write('\nentrypoint: { kind: room, id: entry }\n')

    for state in ('valid', 'invalid'):
        if state == 'invalid':
            with (project / 'records/rooms/entry.yaml').open('a') as source:
                source.write('\nnot-allowed: bad\n')
        actual = {}
        for mode, binary in (('on', on_cli), ('off', off_cli)):
            copy = base / (mode + '-' + state)
            shutil.copytree(project, copy, ignore=shutil.ignore_patterns('.noveltea'))
            public, elapsed = invoke(binary, copy)
            assert 'validationWork' not in public, (mode, state, public)
            observed, profiled_ms = invoke(binary, copy, profile=True)
            actual[mode] = (public, observed)
            if mode == 'on':
                assert 'validationWork' in observed and 'endToEnd' in observed['validationWork']
                measured = observed['validationWork']['endToEnd']
                assert measured['fileByteReads'] > 0 and measured['contentHashes'] > 0
                assert measured['fileBytesRead'] > 0 and measured['contentBytesHashed'] > 0
                assert measured['validationResponseSerializations'] > 0
            else:
                assert not observed['success'] and observed['exitCode'] == 70, observed
                assert 'VALIDATION_PROFILE_UNAVAILABLE' in json.dumps(observed), observed
                assert 'validationWork' not in observed
            print(json.dumps({'mode': mode, 'state': state,
                              'normalMs': elapsed, 'profiledMs': profiled_ms}), flush=True)
            stop(binary)
            warm, _ = invoke(binary, copy, daemon=True)
            repeated, _ = invoke(binary, copy, daemon=True)
            assert warm.get('diagnostics') == public.get('diagnostics'), (mode, state, warm)
            assert repeated.get('diagnostics') == public.get('diagnostics'), (mode, state, repeated)
            assert 'validationWork' not in repeated
            if mode == 'on':
                observed_daemon, _ = invoke(binary, copy, profile=True, daemon=True)
                broker = observed_daemon['validationWork'].get('brokerAuthority', {})
                assert broker.get('brokerAuthorityObservations') == 2, (mode, state, broker)
                assert broker.get('brokerAuthorityMicros', 0) > 0, broker
                if sys.platform.startswith('linux'):
                    assert broker.get('directoryEnumerations') == 0, (mode, state, broker)
            stop(binary)
        a, b = actual['on'][0], actual['off'][0]
        for field in ('success', 'exitCode', 'diagnostics'):
            assert a.get(field) == b.get(field), (state, field, a.get(field), b.get(field))

    if addons:
        script = """
const {createRequire} = require('node:module');
const binding = createRequire(process.cwd() + '/package.json')(process.argv[1]);
const handle = binding.open(process.argv[2]);
try {
  const snap = JSON.parse(binding.snapshot(handle));
  const result = JSON.parse(binding.validateWorking(handle, snap.workingRevision));
  console.log(JSON.stringify(result));
} finally { binding.close(handle); }
"""
        work = []
        for addon in addons:
            value = subprocess.run(['node', '-e', script, str(addon),
                                    str(base / 'on-valid')],
                                   capture_output=True, text=True, timeout=90)
            assert value.returncode == 0, (addon, value.stdout, value.stderr)
            work.append(json.loads(value.stdout))
        assert work[0]['valid'] == work[1]['valid']
        assert work[0]['diagnostics'] == work[1]['diagnostics']
        assert 'work' in work[0] and 'work' not in work[1]

    assembly_source = '''
#include "tools/project_authoring/validation_work_instrumentation.hpp"
static_assert(sizeof(noveltea::authoring::ValidationWorkCounters) == 1);
extern "C" void disabled_counter_loop() {
    noveltea::authoring::ValidationWorkCounters counts;
    noveltea::authoring::ScopedValidationWork scope(counts);
    for (int i = 0; i < 100000; ++i)
        noveltea::authoring::count_validation_work<
            noveltea::authoring::WorkCounter::FileByteReads>();
}
'''
    assembly_path = base / 'off.s'
    compiler = subprocess.run(
        [os.environ.get('CXX', 'c++'), '-std=c++20', '-O2',
         '-DNOVELTEA_ENABLE_VALIDATION_COUNTERS=0', '-I', str(root),
         '-x', 'c++', '-S', '-o', str(assembly_path), '-'],
        input=assembly_source, text=True, capture_output=True)
    assert compiler.returncode == 0, compiler.stderr
    assembly = assembly_path.read_text()
    function = assembly.split('disabled_counter_loop:', 1)[1].split(
        '.size\tdisabled_counter_loop', 1)[0]
    assert '\tret' in function and 'call' not in function, function
    assert 'active_validation_work' not in assembly, assembly
    print('PASS: Release ON/OFF diagnostics, profiling, OFF codegen' +
          (', addon parity' if addons else ''))
