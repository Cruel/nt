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

    for args in [[], [str(story), '--base'], ['--wat'], [str(story), 'extra']]:
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

    def readiness(path, *options, code=0):
        run = subprocess.run([str(binary), '--json', 'narrative', 'readiness', str(path),
                              *options], cwd=root, env=env, capture_output=True, text=True)
        assert run.returncode == code, (run.returncode, run.stdout, run.stderr)
        assert not run.stderr, run.stderr
        value = json.loads(run.stdout)
        assert value['protocolVersion'] == 1 and value['success'] == (code == 0)
        return value

    expectations = [
        ('01-foundation', ('passed', 'needs-work', 'needs-work', 'needs-work', 'needs-work')),
        ('02-architecture', ('passed', 'passed', 'needs-work', 'needs-work', 'needs-work')),
        ('03-events', ('passed', 'passed', 'passed', 'needs-work', 'needs-work')),
        ('04-composition', ('passed', 'passed', 'passed', 'passed', 'unverified')),
    ]
    stages = ('foundation', 'architecture', 'interactive', 'composition', 'review')
    for fixture, expected in expectations:
        path = source / 'tests/fixtures/narrative/planning-stages' / fixture
        value = readiness(path)['readiness']
        actual = tuple(value['design']['stages'][stage]['minimum']
                       for stage in stages)
        assert actual == expected, (fixture, actual, expected)
        assert value['enrichmentAllowed'] is True
        assert value['qualitative']['status'] == 'not-assessed'
        for stage in stages:
            gate = value['design']['stages'][stage]
            assert all(f['requirementId'] and f['code'] and f['status'] in ('satisfied', 'missing',
                'blocked', 'unverified') for f in gate['findings'])
            assert all('path' in f and 'line' in f and 'column' in f
                       for f in gate['findings'])

    # All-status structural success is not approved-canon readiness.
    full = readiness(story, '--stage', 'composition')['readiness']
    assert full['focus']['minimum'] == 'passed'
    assert full['design']['stages']['review']['minimum'] == 'unverified'
    assert full['approved']['stages']['foundation']['minimum'] == 'needs-work'
    assert full['authorization']['status'] == 'not-assessed'
    assert 'engine-playability' in full['qualitative']['unverified']
    assert full['outstanding'] == []

    # A later unfinished Milestone must not invalidate an independent
    # earlier implementation cluster. Editing its prerequisite must.
    staged = root / 'milestone-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', staged)
    new = staged / 'milestones/later-work.md'
    new.write_text("""---
schema: '0.1'
type: milestone
id: milestone.later-work
title: The future opens
status: draft
completeness: partial
decisions: []
change: A later task is still being designed.
arcs: [arc.earned-trust]
fulfillment:
  any_of: []
---
The later work is intentionally unfinished.
""")
    before = snapshot(staged)
    stage_report = readiness(staged, '--stage', 'interactive',
                             '--milestone', 'milestone.accept-investigation')['readiness']
    assert stage_report['focus']['minimum'] == 'needs-work'
    selected = stage_report['clusters'][0]
    assert selected['id'] == 'milestone.accept-investigation'
    assert selected['minimum'] == 'passed'
    assert selected['bounded']['truncated'] is False
    assert 'milestone.later-work' not in selected['recordIds']
    assert 'milestone.accept-investigation' in selected['recordIds']
    assert stage_report['outstanding'] and any(
        f['id'] == 'milestone.later-work' and f['code'] == 'supply-relationship'
        and f['requiredBy'] == 'interactive' for f in stage_report['outstanding'])
    assert snapshot(staged) == before
    assert readiness(staged, '--stage', 'interactive', '--milestone',
                     'milestone.accept-investigation')['readiness'] == stage_report

    change = staged / 'milestones/accept-investigation.md'
    original = change.read_text()
    change.write_text(original.replace(
        'fulfillment:\n  any_of:\n    - [event.inspection-permitted]\n'
        '    - [event.find-cut-strap, event.present-evidence]',
        'completeness: partial\nfulfillment:\n  any_of: []'))
    changed = readiness(staged, '--stage', 'interactive',
                        '--milestone', 'milestone.accept-investigation')['readiness']
    assert changed['clusters'][0]['minimum'] == 'needs-work'
    assert any(f['code'] == 'milestone-fulfillment' and f['status'] == 'missing'
               for f in changed['clusters'][0]['findings'])
    assert any(f['id'] == 'milestone.accept-investigation' and
               f['code'] == 'supply-relationship' for f in changed['outstanding'])

    # Bounded dependency expansion must be explicit rather than silently
    # declaring a truncated implementation handoff ready.
    bounded = root / 'bounded-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', bounded)
    target = bounded / 'milestones/accept-investigation.md'
    text = target.read_text()
    start = text.index('fulfillment:\n')
    end = text.index('---\n', start)
    target.write_text(text[:start] + 'fulfillment:\n  any_of:\n'
                      '    - [event.chain-0]\n' + text[end:])
    for idx in range(7):
        after = f'[event.chain-{idx + 1}]' if idx < 6 else '[]'
        (bounded / f'events/chain-{idx}.md').write_text(f"""---
schema: '0.1'
type: event
id: event.chain-{idx}
title: Linked earlier requirement
status: draft
decisions: []
participants: []
arcs: [arc.stolen-warning]
after: {after}
consequences: [Advance the chain]
prerequisites:
  any_of:
    - completed: []
      not_completed: []
steps: []
---
A declared predecessor.
""")
    bound = readiness(bounded, '--stage', 'interactive',
                      '--milestone', 'milestone.accept-investigation')['readiness']['clusters'][0]
    assert bound['bounded']['truncated'] is True
    assert bound['minimum'] == 'unverified'
    assert len(bound['recordIds']) <= 128

    # Approved scope excludes unrelated draft/superseded records. Status is
    # not inferred from draft structural reachability.
    canon = root / 'approved-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', canon)
    direction = canon / 'creative-direction/last-bell.md'
    direction.write_text(direction.read_text().replace('status: draft', 'status: approved'))
    only = readiness(canon, '--view', 'approved', '--stage', 'foundation')['readiness']
    assert only['focus']['minimum'] == 'passed'
    assert only['approved']['stages']['architecture']['minimum'] == 'needs-work'
    bad_draft = canon / 'events/horn-warning.md'
    bad_draft.write_text(bad_draft.read_text().replace(
        'event.question-ivo', 'event.does-not-exist'))
    bad = readiness(canon, '--view', 'approved', '--stage', 'foundation', code=1)
    assert any(d['code'] == 'broken-reference' for d in bad['diagnostics'])
    assert bad['readiness']['focus']['minimum'] == 'passed'
    assert bad['readiness']['design']['stages']['architecture']['minimum'] == 'needs-work'
    assert any(f['code'] == 'broken-reference' and f['path'] == 'events/horn-warning.md'
               and f['line'] > 1 and f['column'] > 0
               for f in bad['readiness']['design']['stages']['architecture']['findings'])

    # Rejected records have no admitted status: never silently drop their errors
    # from a readiness gate (including a requested implementation cluster).
    rejected = root / 'rejected-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/planning-stages/04-composition', rejected)
    for document in rejected.rglob('*.md'):
        document.write_text(document.read_text().replace('status: draft', 'status: approved'))
    baseline = readiness(rejected, '--stage', 'composition')['readiness']
    assert all(baseline[view]['stages']['composition']['minimum'] == 'passed'
               for view in ['design', 'approved'])
    for text in ['not frontmatter', '---\ninvalid: [\n---\nProse',
                 "---\nschema: broken\n---\nProse"]:
        (rejected / 'broken.md').write_text(text)
        value = readiness(rejected, '--stage', 'composition', '--milestone',
                          'milestone.warning', code=1)['readiness']
        assert value['focus']['minimum'] != 'passed'
        assert value['clusters'][0]['minimum'] != 'passed'
        assert all(value[view]['stages']['foundation']['minimum'] != 'passed'
                   for view in ['design', 'approved'])
        assert any(f['path'] == 'broken.md' for f in value['focus']['blockingGaps'])

    uncertain = root / 'uncertain-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/planning-stages/04-composition', uncertain)
    event = uncertain / 'events/restore-bell.md'
    original = event.read_text()
    event.write_text(original.replace('not_completed: []',
        'not_completed: []\n      unverified: Access has not been verified.'))
    value = readiness(uncertain)['readiness']
    for stage, code in [('architecture', 'milestone-route'),
                        ('interactive', 'milestone-fulfillment')]:
        assert next(f for f in value['design']['stages'][stage]['findings']
                    if f['code'] == code)['status'] == 'unverified'
    event.write_text(original.replace('completeness: complete', 'completeness: partial'))
    value = readiness(uncertain)['readiness']
    assert next(f for f in value['focus']['findings']
                if f['code'] == 'milestone-fulfillment')['status'] == 'missing'

    # State producers are dependencies even without explicit completed-Event links.
    producers = root / 'state-producer-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/planning-stages/04-composition', producers)
    (producers / 'facts').mkdir()
    (producers / 'facts/ready.md').write_text("""---
schema: '0.1'
type: fact
id: fact.ready
title: Repair supplies
status: draft
decisions: []
initial: false
---
The repair supplies are ready.
""")
    event = producers / 'events/restore-bell.md'
    original = event.read_text()
    event.write_text(original.replace('not_completed: []',
        'not_completed: []\n      conditions:\n'
        '        - kind: truth\n          fact: fact.ready\n          value: true'))
    setter = producers / 'events/get-ready.md'
    setter.write_text(original.replace('event.restore-bell', 'event.get-ready').replace(
        'effects: []', 'effects:\n          - kind: truth\n'
        '            fact: fact.ready\n            value: true'))
    value = readiness(producers, '--milestone', 'milestone.warning')['readiness']
    assert value['focus']['minimum'] == 'passed'
    assert value['clusters'][0]['minimum'] == 'passed'
    assert 'event.get-ready' in value['clusters'][0]['recordIds']
    assert not value['clusters'][0]['bounded']['truncated']
    setter_source = setter.read_text()
    setter.write_text(setter_source.replace('value: true', 'value: false'))
    value = readiness(producers, '--milestone', 'milestone.warning', code=1)['readiness']
    assert value['clusters'][0]['minimum'] != 'passed'
    setter.write_text(setter_source)
    event.write_text(original.replace('conditions: []',
        'conditions:\n          - kind: truth\n            fact: fact.ready\n            value: true'))
    value = readiness(producers, '--milestone', 'milestone.warning')['readiness']
    assert value['clusters'][0]['minimum'] == 'passed'
    assert 'event.get-ready' in value['clusters'][0]['recordIds']

    # Recursively discovered state writers obey the same depth budget. A
    # truncated producer chain must not be reported as an impossible route.
    fact_source = (producers / 'facts/ready.md').read_text()
    for idx in range(6):
        (producers / f'facts/supply-{idx}.md').write_text(fact_source.replace(
            'fact.ready', f'fact.supply-{idx}'))
        writer = setter if idx == 0 else producers / f'events/supply-{idx - 1}.md'
        writer.write_text(writer.read_text().replace('not_completed: []',
            'not_completed: []\n      conditions:\n'
            f'        - kind: truth\n          fact: fact.supply-{idx}\n          value: true'))
        (producers / f'events/supply-{idx}.md').write_text(setter_source.replace(
            'event.get-ready', f'event.supply-{idx}').replace('fact.ready', f'fact.supply-{idx}'))
    value = readiness(producers, '--milestone', 'milestone.warning')['readiness']
    assert value['focus']['minimum'] == 'passed'
    assert value['clusters'][0]['bounded']['truncated']
    assert value['clusters'][0]['minimum'] == 'unverified'

    # Different Puzzles may share solution Events without sharing requirement IDs.
    shared = root / 'shared-puzzle-readiness'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', shared)
    puzzle = shared / 'puzzles/tower-access.md'
    (shared / 'puzzles/second.md').write_text(puzzle.read_text().replace(
        'puzzle.tower-access', 'puzzle.second'))
    value = readiness(shared)['readiness']
    findings = value['focus']['findings']
    keys = [f['requirementId'] for f in findings]
    assert len(keys) == len(set(keys))
    for code in ['puzzle-solution', 'puzzle-clue-access']:
        assert {f['path'] for f in findings if f['code'] == code} >= {
            'puzzles/tower-access.md', 'puzzles/second.md'}
    print('Readiness regression contracts: rejected input, uncertainty, state dependencies and IDs passed.')

    missing = readiness(root / 'missing-root', code=1)
    assert any(d['code'] == 'io' for d in missing['diagnostics'])
    invalid = readiness(story, '--milestone', 'event.question-ivo', code=1)
    assert invalid['diagnostics'][0]['code'] == 'invalid-milestone-id'
    for args in [
        ('--stage', 'fiction'), ('--view', 'all'),
        ('--stage', 'interactive', '--stage', 'interactive'),
        ('--milestone', 'milestone.accept-investigation', '--milestone', 'milestone.accept-investigation'),
        ('--milestone',), ('--unknown', 'value'),
    ]:
        assert readiness(story, *args, code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'
    assert readiness(story, '--project', str(root), code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'
    print('Native readiness: staged minimums, status scopes, focused cluster, changed prerequisite, and errors passed.')
