#!/usr/bin/env python3
"""Syntax-certify the release CLI's host narrative sources with Clang.

Use the real CMake compilation database so the check inherits exactly the
headers and compile definitions used by the standalone native CLI.
"""
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SOURCE_LIST = ROOT / 'cmake/NovelTeaHostNarrativeSources.cmake'
expected = [ROOT / source for source in re.findall(
    r'(tools/narrative/[A-Za-z_]+\.cpp)',
    SOURCE_LIST.read_text(encoding='utf-8'), re.MULTILINE)]
if not expected or len(set(expected)) != len(expected):
    raise SystemExit('Missing or duplicate host Narrative source entries')
if len(sys.argv) != 2:
    raise SystemExit('Usage: check-host-narrative-clang.py <compile_commands.json>')
clang = shutil.which('clang++')
if not clang:
    raise SystemExit('Clang compiler is required to certify host Narrative sources')
commands = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
for source in expected:
    matches = [entry for entry in commands if Path(entry['file']).resolve() == source
               and 'noveltea_narrative.dir' in entry.get('output', entry['command'])]
    if len(matches) != 1:
        raise SystemExit(f'Expected one standalone host Narrative compile command for {source}: {len(matches)}')
    entry = matches[0]
    args = shlex.split(entry['command'])
    if Path(args[0]).name == 'ccache':
        args.pop(0)
    # Ignore output/dependency switches and GCC gcov flags. This is a syntax
    # check; it must not overwrite any objects or coverage counters.
    options = []
    skip_next = False
    for arg in args[1:]:
        if skip_next:
            skip_next = False
            continue
        if arg in ('-o', '-MT', '-MF', '-MQ'):
            skip_next = True
        elif arg not in ('-c', '-MD', '-MMD', '--coverage', '-fprofile-arcs', '-ftest-coverage') \
                and not arg.startswith('-fprofile-update='):
            options.append(arg)
    print(f'Clang host Narrative: {source.relative_to(ROOT)}', flush=True)
    subprocess.run([clang, *options, '-fsyntax-only', '-Werror', '-Werror=string-compare'],
                   cwd=entry['directory'], check=True)
print(f'All {len(expected)} host Narrative sources Clang-certified.')
