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

    def invoke(*args, cwd=root, expected=0, timeout=45):
        completed = subprocess.run([str(installed), '--json', *map(str, args)],
                                   cwd=cwd, env=env, capture_output=True, text=True,
                                   timeout=timeout)
        assert completed.returncode == expected, (args, completed)
        assert not completed.stderr, (args, completed.stderr)
        result = json.loads(completed.stdout)
        assert result['exitCode'] == expected and result['protocolVersion'] == 1, result
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
            broker_pid = status['pid']
            child_file = Path(f'/proc/{broker_pid}/task/{broker_pid}/children')
            assert child_file.exists(), status
            owner_ids = []
            for raw_pid in child_file.read_text().split():
                cmdline = Path(f'/proc/{raw_pid}/cmdline').read_bytes()
                if b'__daemon-owner' in cmdline and b'--owner-worker-id\x001\x00' in cmdline:
                    owner_ids.append(int(raw_pid))
                    assert Path(f'/proc/{raw_pid}/exe').resolve() == installed
            assert len(owner_ids) == 1, owner_ids
            os.kill(owner_ids[0], signal.SIGKILL)
            time.sleep(0.1)
            recovered = project_command('entity', 'inspect', 'rooms', 'renamed')
            assert recovered == changed
            assert daemon_status()['projectSessions'] == 2

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
