"""#549: relocated direct C++ CLI Project-owner lifecycle over the public broker seam."""

import concurrent.futures
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


binary = Path(sys.argv[1]).resolve()
source_root = Path(sys.argv[2]).resolve()
with tempfile.TemporaryDirectory(prefix='nt-549-') as temporary:
    root = Path(temporary)
    installed = root / binary.name
    shutil.copy2(binary, installed)
    shutil.copytree(binary.parent / 'assets/system', root / 'assets/system')
    project = root / 'project'
    env = os.environ.copy()
    env.pop('NOVELTEA_NO_DAEMON', None)
    env.update(NOVELTEA_CLI_CERTIFICATION='1',
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(root / 'daemon'))

    def invoke(*args, cwd=root, expected=0, timeout=45, input_text=None):
        completed = subprocess.run([str(installed), '--json', *map(str, args)],
                                   cwd=cwd, env=env, capture_output=True, text=True,
                                   timeout=timeout, input=input_text)
        assert expected is None or completed.returncode == expected, (args, completed)
        assert not completed.stderr, (args, completed.stderr)
        result = json.loads(completed.stdout)
        assert result['exitCode'] == completed.returncode and result['protocolVersion'] == 1, result
        return result

    def project_command(*args, local=False, expected=0, cwd=root):
        flags = ('--no-daemon',) if local else ()
        return invoke(*flags, '--project', project, *args, expected=expected, cwd=cwd)

    def daemon_status():
        return invoke('daemon', 'status')['daemon']

    try:
        assert not daemon_status()['running']
        invoke('--no-daemon', 'project', 'create', project, '--name', 'Owner Certification')
        project_command('entity', 'create', 'rooms', 'entry')
        # Establish a valid compiled-gameplay entrypoint so brokered validation
        # can publish an exact result, rather than caching a missing-source error.
        with (project / 'project.yaml').open('a', encoding='utf-8') as output:
            output.write('\nentrypoint:\n  kind: room\n  id: entry\n')
        status = daemon_status()
        assert status['running'] and status['projectSessions'] == 1, status
        assert status['disposableWorkers'] >= 1, status

        # Heavy shader preparation must cross the native pinned-snapshot seam,
        # not silently execute in the caller or resident Project owner.
        before_handoffs = status['engineeringCounters']['snapshotHandoffs']
        shader_args = ('shaders', 'compile', '--variant', 'glsl-330')
        assert project_command(*shader_args) == project_command(*shader_args, local=True)
        after_shaders = daemon_status()
        assert after_shaders['engineeringCounters']['snapshotHandoffs'] > before_handoffs, after_shaders

        # Every Project-bound heavyweight family uses a disposable native
        # process, even when rejecting an invalid request before publication.
        # The executable-seam result must match direct C++ execution.
        heavy_cases = [
            ('package', 'export', '--unknown-option'),
            ('platform', 'export', '--output', root / 'platform'),
            ('comfyui', 'run', 'missing-native-workflow'),
        ]
        for heavy in heavy_cases:
            before = daemon_status()['engineeringCounters']['snapshotHandoffs']
            local = invoke('--no-daemon', '--project', project, *heavy, expected=None)
            remote = invoke('--project', project, *heavy, expected=local['exitCode'])
            assert remote == local, (heavy, remote, local)
            after = daemon_status()['engineeringCounters']['snapshotHandoffs']
            assert after > before, (heavy, before, after)

        before_stdin = daemon_status()['engineeringCounters']['snapshotHandoffs']
        for form in ('run-spec', 'run-ui-spec'):
            remote = invoke('--project', project, 'test', form, input_text='not JSON', expected=2)
            local = invoke('--no-daemon', '--project', project, 'test', form,
                           input_text='not JSON', expected=2)
            assert remote == local, (remote, local)
        before_tests = daemon_status()['engineeringCounters']['snapshotHandoffs']
        assert before_tests == before_stdin + 2
        project_command('entity', 'create', 'tests', 'native-worker')
        cold_tests = project_command('test', 'run')
        assert cold_tests['success'], cold_tests
        assert cold_tests['native']['report']['counts']['passed'] == 1, cold_tests
        after_tests = daemon_status()
        assert after_tests['engineeringCounters']['snapshotHandoffs'] > before_tests, after_tests
        warm_tests = project_command('test', 'run')
        assert warm_tests['success'], warm_tests
        assert warm_tests['runtimeCache']['status'] == 'hit', warm_tests
        assert daemon_status()['engineeringCounters']['snapshotHandoffs'] == after_tests['engineeringCounters']['snapshotHandoffs']
        package_path = root / 'runtime.ntpkg'
        before_package = daemon_status()['engineeringCounters']['snapshotHandoffs']
        package = project_command('package', 'export', '--output', package_path)
        assert package['success'] and package_path.is_file(), package
        assert daemon_status()['engineeringCounters']['snapshotHandoffs'] > before_package

        room_args = ('entity', 'inspect', 'rooms', 'entry')
        baseline = project_command(*room_args, local=True)
        for _ in range(3):
            assert project_command(*room_args) == baseline
        assert project_command(*room_args, cwd=project / 'records' / 'rooms') == baseline
        if os.name != 'nt':
            alias = root / 'project-alias'
            alias.symlink_to(project, target_is_directory=True)
            assert invoke('--project', alias, *room_args) == invoke(
                '--no-daemon', '--project', alias, *room_args)
            assert daemon_status()['projectSessions'] == 1
            assert invoke('--project', alias, *shader_args) == invoke(
                '--no-daemon', '--project', alias, *shader_args)

        # Pause only after immutable hydration. Corrupt live authored data and
        # reconcile it through the owner while the old worker remains pinned.
        # Reading live Project semantics would return WORKSPACE_SOURCE_READ,
        # rather than the captured generation's physical proof conflict.
        room_source = project / 'records' / 'rooms' / 'entry.yaml'
        original_room = room_source.read_bytes()
        barrier = root / 'pinned-worker'
        barrier_env = {**env, 'NOVELTEA_CLI_CERTIFICATION_PINNED_BARRIER': str(barrier)}

        def paused_worker():
            barrier.with_suffix('.ready').unlink(missing_ok=True)
            barrier.with_suffix('.release').unlink(missing_ok=True)
            process = subprocess.Popen(
                [str(installed), '--json', '--project', str(project), *shader_args],
                cwd=root, env=barrier_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True)
            deadline = time.monotonic() + 20
            ready = barrier.with_suffix('.ready')
            while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                time.sleep(.02)
            assert ready.exists(), process.communicate(timeout=5)
            return process, int(ready.read_text())

        process, worker_pid = paused_worker()
        room_source.write_text('not: a valid Room\n', encoding='utf-8')
        invalid = project_command('validate', expected=3)
        assert invalid['diagnostics'][0]['code'] == 'WORKSPACE_SOURCE_READ', invalid
        barrier.with_suffix('.release').touch()
        out, err = process.communicate(timeout=30)
        assert process.returncode == 3 and not err, (process.returncode, out, err)
        rejected = json.loads(out)
        assert rejected['diagnostics'][0]['code'] == 'WORKSPACE_REVISION_CONFLICT', rejected
        room_source.write_bytes(original_room)

        # Killing a pinned worker must fail only its request and leave the
        # resident owner and broker usable for the next native heavy job.
        process, worker_pid = paused_worker()
        os.kill(worker_pid, signal.SIGTERM)
        out, err = process.communicate(timeout=30)
        assert process.returncode == 70 and not err, (process.returncode, out, err)
        assert not json.loads(out)['success']
        process, worker_pid = paused_worker()
        process.terminate()
        process.communicate(timeout=10)
        deadline = time.monotonic() + 15
        while daemon_status()['disposableBusyWorkers'] and time.monotonic() < deadline:
            time.sleep(.05)
        assert daemon_status()['disposableBusyWorkers'] == 0
        assert project_command(*shader_args) == project_command(*shader_args, local=True)
        assert project_command(*room_args) == baseline

        local_human = subprocess.run([str(installed), '--no-daemon', '--project', str(project),
                                      *room_args], cwd=root, env=env, capture_output=True, text=True)
        remote_human = subprocess.run([str(installed), '--project', str(project), *room_args],
                                       cwd=root, env=env, capture_output=True, text=True)
        assert (local_human.returncode, local_human.stdout, local_human.stderr) == (
            remote_human.returncode, remote_human.stdout, remote_human.stderr)
        # A positional record ID named 'validate' must not be mistaken for the
        # validation command or poison its exact-result retention key.
        project_command('entity', 'create', 'rooms', 'validate')
        assert project_command('entity', 'inspect', 'rooms', 'validate')['id'] == 'validate'
        assert daemon_status()['exactValidationResults'] == 0
        baseline = project_command(*room_args, local=True)
        assert project_command('validate') == project_command('validate', local=True)
        retained = daemon_status()
        assert retained['exactValidationResults'] >= 1, retained
        previous_hits = retained['engineeringCounters']['exactResultHits']
        assert project_command('validate') == project_command('validate', local=True)
        hits = daemon_status()
        assert hits['engineeringCounters']['exactResultHits'] > previous_hits, hits
        # The broker's best-effort exact-result publication is observable on
        # disk: it must contain only the native result+physical proof, never
        # a stale parsed Project generation.
        authoring_cache = project / '.noveltea' / 'cache' / 'authoring' / 'current.json'
        deadline = time.monotonic() + 5
        while not authoring_cache.is_file() and time.monotonic() < deadline:
            time.sleep(.05)
        assert authoring_cache.is_file(), 'Broker did not publish native validation proof'

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(project_command, *room_args) for _ in range(8)]
            for future in futures:
                assert future.result() == baseline
        assert daemon_status()['projectSessions'] == 1

        # Real authored Project read through the installed native owner, not
        # only the minimal native-created fixture.
        feature = source_root / 'tests/projects/feature-lab'
        args = ('entity', 'inspect', 'rooms', 'active-text-finish')
        feature_local = invoke('--no-daemon', '--project', feature, *args)
        assert invoke('--project', feature, *args) == feature_local
        assert daemon_status()['projectSessions'] == 2
        feature_copy = root / 'feature-lab'
        shutil.copytree(feature, feature_copy, ignore=shutil.ignore_patterns('.noveltea'))
        feature_shaders = invoke('--project', feature_copy, *shader_args, timeout=180)
        feature_local_shaders = invoke('--no-daemon', '--project', feature_copy,
                                       *shader_args, timeout=180)
        # The first invocation compiles; the second legitimately hits its cache.
        # Everything describing the generated shader bytes must still agree.
        for result in (feature_shaders, feature_local_shaders):
            assert result['native']['outputs'], result
            for output in result['native']['outputs']:
                output.pop('cacheHit')
        assert feature_shaders == feature_local_shaders

        # A brokered mutation must commit exactly once and the resident owner
        # must not return stale in-RAM state on the following request.
        project_command('entity', 'rename', 'rooms', 'entry', 'renamed')
        assert project_command('entity', 'inspect', 'rooms', 'entry', expected=4)[
            'diagnostics'][0]['code'] == 'authoring.entity.not_found'
        renamed = project_command('entity', 'inspect', 'rooms', 'renamed')
        assert renamed['record']['id'] == 'renamed'
        assert renamed == project_command('entity', 'inspect', 'rooms', 'renamed', local=True)

        # External physical source changes invalidate the resident view.
        source = project / 'records' / 'rooms' / 'renamed.yaml'
        before = source.read_text(encoding='utf-8')
        assert 'label: Room entry' in before, before
        source.write_text(before.replace('label: Room entry',
                                         'label: Externally updated', 1), encoding='utf-8')
        changed = project_command('entity', 'inspect', 'rooms', 'renamed')
        assert changed['record']['label'] == 'Externally updated', changed
        assert changed == project_command('entity', 'inspect', 'rooms', 'renamed', local=True)

        # Once a resident owner exits unexpectedly, the existing broker must
        # replace it rather than replaying a possibly committed mutation.
        if sys.platform.startswith('linux'):
            current = daemon_status()
            owners = [owner for owner in current['engineeringOwners']
                      if owner['canonicalRoot'] == str(project.resolve())]
            assert len(owners) == 1, (owners, current)
            owner = owners[0]
            owner_pid = owner['pid']
            cmdline = Path(f'/proc/{owner_pid}/cmdline').read_bytes()
            assert b'__daemon-owner\x00' in cmdline, cmdline
            assert (b'--owner-worker-id\x00' + str(owner['workerId']).encode() + b'\x00'
                    in cmdline), cmdline
            assert Path(f'/proc/{owner_pid}/exe').resolve() == installed
            sessions_before_failure = current['projectSessions']
            os.kill(owner_pid, signal.SIGKILL)
            time.sleep(0.1)
            recovered = project_command('entity', 'inspect', 'rooms', 'renamed')
            assert recovered == changed
            assert daemon_status()['projectSessions'] == sessions_before_failure
            assert project_command(*shader_args) == project_command(*shader_args, local=True)

        # Exact-result reuse includes deterministic semantic validation errors.
        # It must also reject the prior successful generation after an edit.
        config = project / 'project.yaml'
        authored = config.read_text(encoding='utf-8')
        invalid_source, replacements = re.subn(
            r'(?m)^entrypoint:\n(?:[ \t]+[^\n]*\n)*', '', authored, count=1)
        assert replacements == 1
        config.write_text(invalid_source, encoding='utf-8')
        invalid = project_command('validate', expected=4)
        assert invalid == project_command('validate', local=True, expected=4)
        hits_before = daemon_status()['engineeringCounters']['exactResultHits']
        assert project_command('validate', expected=4) == invalid
        assert daemon_status()['engineeringCounters']['exactResultHits'] > hits_before
        config.write_text(authored, encoding='utf-8')
        assert project_command('validate') == project_command('validate', local=True)

        stopped = invoke('daemon', 'stop')['daemon']
        assert not stopped['running']
        assert not daemon_status()['running']
        assert project_command('entity', 'inspect', 'rooms', 'renamed') == changed
        assert daemon_status()['running']
        print('Native C++ relocated broker, warm owner, mutation, disk reconciliation, '
              'concurrency, owner replacement and restart PASSED.')
    finally:
        try:
            invoke('daemon', 'stop', timeout=10)
        except (AssertionError, subprocess.TimeoutExpired):
            pass
