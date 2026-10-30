"""Manual daemon-backed label-edit timings; no machine-dependent CI budget.

Usage: python3 tests/native_cli/validation_performance.py <noveltea> <source-root>
"""

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
with tempfile.TemporaryDirectory(prefix='nt-validation-performance-') as temporary:
    root = Path(temporary)
    env = os.environ.copy()
    env.pop('NOVELTEA_NO_DAEMON', None)
    env.update(NOVELTEA_CLI_CERTIFICATION='1',
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(root / 'daemon'))

    def invoke(*args):
        result = subprocess.run([str(binary), '--json', *map(str, args)],
                                env=env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, (args, result.stdout, result.stderr)
        payload = json.loads(result.stdout)
        assert payload['success'] and not result.stderr, payload
        return payload

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

            # Creation uses the broker too. Stop it so every size starts with
            # a fresh owner, and exclude disposable validation-cache reuse.
            invoke('daemon', 'stop')
            shutil.rmtree(project / '.noveltea/cache', ignore_errors=True)

            def validate():
                started = time.perf_counter()
                invoke('--project', project, 'validate')
                return round((time.perf_counter() - started) * 1000, 2)

            cold, unchanged = validate(), validate()
            original = room.read_text()
            label = re.search(r'^label: .*$', original, re.M)
            changed = []
            for index in range(3):
                replacement = f'label: Performance Bench {index}'
                room.write_text(original[:label.start()] + replacement + original[label.end():]
                                if label else original + '\n' + replacement + '\n')
                changed.append(validate())
            print(json.dumps({'project': size, 'cold_ms': cold, 'unchanged_ms': unchanged,
                              'changed_ms': changed,
                              'median_changed_ms': statistics.median(changed)}), flush=True)
            if size == 'feature-lab':
                # A tracked Layout Lua edit exercises the same native public
                # validation pipeline without changing any YAML owner.
                lua = project / 'records/layouts/feature-lab-hud/layout.lua'
                original_lua = lua.read_text()
                lua_changed = []
                for index in range(3):
                    lua.write_text(original_lua + f'\n-- Validation bench {index}\n')
                    lua_changed.append(validate())
                print(json.dumps({'project': 'feature-lab-lua', 'changed_ms': lua_changed,
                                  'median_changed_ms': statistics.median(lua_changed)}),
                      flush=True)
    finally:
        invoke('daemon', 'stop')
