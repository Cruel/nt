"""Public native CLI acceptance against the pinned canonical Story, without a Project."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()
source = Path(sys.argv[2]).resolve()
contract = json.loads((source / 'tools/narrative/generated/contract.json').read_text(encoding='utf-8'))
header = (source / 'tools/narrative/generated/contract.hpp').read_text(encoding='utf-8')
embedded = json.loads(header.split('R"NTCATALOG(', 1)[1].split(')NTCATALOG"', 1)[0])
assert embedded == {'revision': contract['revision'], 'record': contract['record']}
assert contract['repository'] == 'Cruel/noveltea-skills'


def snapshot(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file() and not p.is_symlink()}


with tempfile.TemporaryDirectory(prefix='nt-narrative-') as temporary:
    root = Path(temporary)
    story = root / 'standalone story'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', story)
    env = dict(os.environ, NOVELTEA_USER_CONFIG_ROOT=str(root / 'no-config'))

    def validate(path=story, code=0, *extra):
        result = subprocess.run([str(binary), '--json', *extra, 'narrative', 'validate', str(path)],
                                cwd=root, env=env, capture_output=True, encoding='utf-8')
        assert result.returncode == code, (result.returncode, result.stdout, result.stderr)
        assert not result.stderr, result.stderr
        value = json.loads(result.stdout)
        assert value['protocolVersion'] == 1
        assert value['success'] == (code == 0)
        return value

    before = snapshot(root)
    report = validate()
    assert report['diagnostics'] == []
    assert len(report['catalog']['records']) == 36
    assert report['catalog']['coverage']['minimumProgress'] == 'declared-milestones-reachable'
    assert snapshot(root) == before
    assert not (root / 'no-config').exists()
    print('Standalone narrative positive/read-only contract passed.')

    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

    def project(value):
        if isinstance(value, list):
            return [project(v) for v in value]
        if isinstance(value, dict):
            return {k: project(v) for k, v in value.items()
                    if k not in ('keys', 'pointer', 'action', 'witness', 'branches')}
        return value

    suite = json.loads((source / 'tests/fixtures/narrative/conformance.json').read_text(encoding='utf-8'))
    assert suite['revision'] == contract['revision'] == report['catalog']['contractRevision']
    failures = []
    for case in suite['cases']:
        candidate = root / case['name']
        shutil.copytree(source / 'tests/fixtures/narrative' / case['fixture'], candidate)
        for path, text in case['patches'].items():
            (candidate / path).write_bytes(text.encode('utf-8'))
        expected = case['expected']
        actual = validate(candidate, 1 if expected['diagnostics'] else 0)['catalog']
        diagnostics = [{k: d[k] for k in ('code', 'path', 'line', 'column')} for d in actual['diagnostics']]
        order = lambda d: (d['code'], d['path'], d['line'], d['column'])
        differences = []
        if sorted(diagnostics, key=order) != sorted(expected['diagnostics'], key=order):
            differences.append(('diagnostics', diagnostics, expected['diagnostics']))
        if digest(actual['records']) != expected['recordsHash']:
            differences.append(('records',))
        if digest(project(actual['coverage'])) != expected['coverageHash']:
            differences.append(('coverage',))
        if differences:
            failure_path = Path(tempfile.gettempdir()) / ('nt-narrative-' + case['name'] + '-actual.json')
            failure_path.write_text(json.dumps(actual, indent=2))
            failures.append((case['name'], differences, str(failure_path)))
    assert not failures, failures
    print(f"Pinned upstream conformance passed: {len(suite['cases'])} positive/negative catalogs.")

    # No parent Project discovery, even when the nearest project.yaml is corrupt.
    (root / 'project.yaml').write_text('invalid: [project')
    (story / 'ignored.txt').write_text('not a record')
    if os.name != 'nt':
        (story / 'ignored.md').symlink_to(root / 'project.yaml')
        (story / 'loop').symlink_to(root, target_is_directory=True)
    unchanged = snapshot(root)
    assert validate()['catalog']['coverage'] == report['catalog']['coverage']
    assert snapshot(root) == unchanged
    missing = validate(root / 'missing', 1)
    assert any(d['code'] == 'io' and d['line'] == 1 for d in missing['diagnostics'])

    for args in [[], [str(story), '--base', 'HEAD'], ['--wat'], [str(story), 'extra']]:
        result = subprocess.run([str(binary), '--json', 'narrative', 'validate', *args],
                                cwd=root, env=env, capture_output=True, encoding='utf-8')
        assert result.returncode == 2 and not result.stderr
        assert json.loads(result.stdout)['diagnostics'][0]['code'] == 'CLI_USAGE'
    assert validate(story, 2, '--project', str(root))['diagnostics'][0]['code'] == 'CLI_USAGE'

    small = root / 'small'
    shutil.copytree(source / 'tests/fixtures/narrative/planning-stages/01-foundation', small)
    record = small / 'creative-direction/harbor.md'
    original = record.read_text(encoding='utf-8')
    for content, expected in [
        ('not frontmatter', 'frontmatter'),
        ('---\n---\nProse', 'schema'),
        ('---\ninvalid: [\n---\nProse', 'yaml'),
        (original.replace('title:', 'title: duplicated\ntitle:'), 'yaml'),
        (original.replace('title: The Harbor Warning', 'title: !unsupported text'), 'yaml'),
        (original.replace('title: The Harbor Warning', '!unsupported title: The Harbor Warning'), 'yaml'),
        (original.replace('title: The Harbor Warning', 'title: &name text\ntone: *name').replace('tone: Urgent and compassionate\n', ''), 'yaml'),
    ]:
        record.write_text(content)
        value = validate(small, 1)
        assert any(d['code'] == expected and d['line'] >= 1 and d['column'] >= 1 for d in value['diagnostics']), value
    record.write_bytes(original.encode('utf-8') + b'\xff')
    assert any(d['code'] == 'io' for d in validate(small, 1)['diagnostics'])
    record.write_bytes(original.replace('\n', '\r\n').encode())
    validate(small)
    record.write_text(original + '\n' + 'Long readable prose. ' * 100000)
    validate(small)
    record.write_text(original)

    # Search exhaustion must never become an impossibility/universal-state claim.
    for i in range(13):
        (small / f'event-{i}.md').write_text(f'''---
schema: '0.1'
type: event
id: event.independent-{i}
title: Independent Event
status: draft
decisions: []
participants: []
arcs: []
consequences: [Something happens]
after: []
prerequisites:
  any_of:
    - completed: []
      not_completed: []
steps: []
---
Independent fictional occurrence.
''')
    limited = validate(small)['catalog']['coverage']
    assert limited['search']['truncated'] is True
    assert all(e['status'] in ('reachable', 'unverified') for e in limited['eventProgress'])
    assert report['catalog']['authorization']['status'] == 'not-assessed'
    print('I/O, routing, YAML, read-only and bounded-search contracts passed.')
