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

    # Context Manifest reuses native catalog parsing but never exports narrative text.
    def context(path, *options, code=0):
        run = subprocess.run([str(binary), '--json', 'narrative', 'context', str(path),
                              *options], cwd=root, env=env, capture_output=True, text=True)
        assert run.returncode == code, (run.returncode, run.stdout, run.stderr)
        assert not run.stderr, run.stderr
        result = json.loads(run.stdout)
        assert result['protocolVersion'] == 1
        assert result['success'] == (code == 0)
        return result

    maya = root / 'maya-post-trial'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', maya)
    # Use the canonical Last Bell relationship/branch graph with an explicitly
    # resolved Maya/post-trial task, not an unparsed free-text query.
    renames = [('character.mara', 'character.maya'),
               ('event.question-ivo', 'event.post-trial'),
               ('narrative-position.after-question', 'narrative-position.post-trial')]
    for document in maya.rglob('*.md'):
        contents = document.read_text(encoding='utf-8')
        for before_id, after_id in renames:
            contents = contents.replace(before_id, after_id)
        document.write_text(contents, encoding='utf-8')
    original_snapshot = snapshot(maya)
    options = ('--kind', 'dialogue', '--id', 'character.maya', '--id', 'event.post-trial',
               '--position', 'narrative-position.post-trial', '--scope', 'related')
    manifest = context(maya, *options)['manifest']
    files = manifest['files']
    by_id = {item['id']: item for item in files}
    assert manifest['contractRevision'] == contract['revision']
    assert manifest['bounded'] == {'maxDepth': 2, 'maxFiles': 128, 'truncated': False}
    assert len(files) == len(by_id)
    assert {'character.maya', 'event.post-trial', 'narrative-position.post-trial'} <= by_id.keys()
    assert all(by_id[id]['priority'] == 'direct' for id in
               ('character.maya', 'event.post-trial', 'narrative-position.post-trial'))
    assert by_id['relationship.mara-ivo']['priority'] == 'conditional'
    assert by_id['creative-direction.last-bell']['priority'] == 'supplementary'
    assert 'world-entity.tide-well' not in by_id  # no recursive world-entity expansion
    assert any(reason['code'] == 'character-relationship' and
               reason['targetId'] == 'character.maya'
               for reason in by_id['relationship.mara-ivo']['inclusions'])
    assert any(reason['code'] == 'event-state-reference' and
               reason['targetId'] == 'choice-point.question-ivo'
               for reason in by_id['choice-point.question-ivo']['inclusions'])
    assert any(reason['code'] == 'position-event'
               for reason in by_id['event.post-trial']['inclusions'])
    for file in files:
        assert set(file) == {'path', 'id', 'sourceRevision', 'status', 'completeness',
                             'dependency', 'priority', 'inclusions'}
        assert file['status'] == 'draft'
        assert file['sourceRevision'].startswith('xxh3-128:')
        assert file['path'].endswith('.md') and not Path(file['path']).is_absolute()
    assert files == sorted(files, key=lambda f: (['direct', 'conditional', 'supplementary'].index(
        f['priority']), f['path']))
    assert context(maya, *options)['manifest'] == manifest
    assert snapshot(maya) == original_snapshot

    focus = context(maya, '--kind', 'dialogue', '--id', 'event.post-trial',
                    '--scope', 'focused')['manifest']
    assert focus['bounded']['maxDepth'] == 1
    assert len(focus['files']) < len(files)
    assert 'creative-direction.last-bell' not in {f['id'] for f in focus['files']}
    assert 'body' not in json.dumps(manifest) and 'metadata' not in json.dumps(manifest)

    # Content revisions are read from raw Markdown bytes, not IDs, schemas or Git.
    selected = maya / by_id['event.post-trial']['path']
    selected.write_bytes(selected.read_bytes() + b'\nA changed line of dialogue.\n')
    changed = context(maya, *options)['manifest']
    updated = {f['id']: f for f in changed['files']}
    assert updated['event.post-trial']['sourceRevision'] != by_id['event.post-trial']['sourceRevision']
    assert {id: f['sourceRevision'] for id, f in updated.items() if id != 'event.post-trial'} == {
        id: f['sourceRevision'] for id, f in by_id.items() if id != 'event.post-trial'}
    assert [f['path'] for f in changed['files']] == [f['path'] for f in files]

    # Draft vs approved is explicit and never silently promoted to canon.
    selected.write_text(selected.read_text().replace('status: draft', 'status: approved'))
    approved = {f['id']: f for f in context(maya, *options)['manifest']['files']}
    assert approved['event.post-trial']['status'] == 'approved'
    assert approved['character.maya']['status'] == 'draft'

    partial = maya / 'characters/mara.md'
    partial.write_text(partial.read_text().replace('status: draft',
                                                 'status: draft\ncompleteness: partial'))
    incomplete = context(maya, *options)['manifest']
    assert any(item['code'] == 'partial-artifact' and item['id'] == 'character.maya'
               for item in incomplete['unresolved'])
    assert next(f for f in incomplete['files'] if f['id'] == 'character.maya')['dependency'] == 'incomplete'

    # A broken typed edge is diagnosable, not resolved through guesswork.
    selected.write_text(selected.read_text().replace('character.maya', 'character.unknown'))
    broken = context(maya, *options, code=1)
    assert any(d['code'] == 'broken-reference' for d in broken['diagnostics'])
    assert any(entry['code'] == 'unresolved-reference' and entry['id'] == 'character.unknown'
               for entry in broken['manifest']['unresolved'])

    invalid = context(story, '--kind', 'event', '--id', 'event.unknown', code=1)
    assert invalid['diagnostics'][0]['code'] == 'invalid-target-id'
    invalid_position = context(story, '--kind', 'dialogue', '--position',
                               'character.maya', code=1)
    assert invalid_position['diagnostics'][0]['code'] == 'invalid-position-id'
    for args in [('--kind', 'invalid', '--id', 'character.maya'),
                 ('--kind', 'dialogue'), ('--kind', 'dialogue', '--id', 'character.maya',
                                        '--scope', 'everything'),
                 ('--kind', 'dialogue', '--id', 'character.maya', '--wat', 'x'),
                 ('--kind', 'dialogue', '--id', 'character.maya', '--id'),
                 ('--kind', 'dialogue', '--id', 'character.maya', '--kind', 'dialogue')]:
        assert context(maya, *args, code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'
    print('Context Manifest selection, witnesses, bounded traversal, status, revisions and errors passed.')
