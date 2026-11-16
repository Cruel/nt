"""Route-aware native estimates, Story-wide footprint, and production-budget cases."""
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


def replace(path, old, new):
    original = path.read_text(encoding='utf-8')
    assert old in original, (path, old)
    path.write_text(original.replace(old, new, 1), encoding='utf-8')


def fingerprint(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file() and not p.is_symlink()}


with tempfile.TemporaryDirectory(prefix='nt-narrative-routes-') as scratch:
    root = Path(scratch)
    story = root / 'story'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', story)
    env = dict(os.environ, NOVELTEA_USER_CONFIG_ROOT=str(root / 'no-config'))

    def invoke(command='metrics', path=story, *, code=0, extra=()):
        run = subprocess.run([str(binary), '--json', 'narrative', command, str(path), *extra],
                             cwd=root, env=env, capture_output=True, text=True)
        assert (run.returncode, run.stderr) == (code, ''), (
            run.returncode, run.stderr, run.stdout[:1000])
        data = json.loads(run.stdout)
        assert data['protocolVersion'] == 1 and data['success'] == (code == 0)
        return data

    # Two reachable endings arise from typed Choice/Relationship consequences.
    # Both use the same harbor illustration, but have separate ending prose.
    direction = story / 'creative-direction/last-bell.md'
    replace(direction, 'status: draft', 'status: approved')
    replace(direction, 'main_arc: arc.stolen-warning\n', '''main_arc: arc.stolen-warning
planning:
  choice_frequency: frequent
  choice_impact: lasting
  branching: {depth: deep, route_exclusivity: substantial}
  first_playthrough: {min_minutes: 110, max_minutes: 130}
  production:
    illustrated_backgrounds: {count: {max: 1}, firmness: soft}
    background_variants: {count: {max: 2}, firmness: hard}
    character_artwork:
      main: {count: {max: 1}, firmness: hard}
      supporting: {count: {max: 0}, firmness: soft}
  illustration_concepts:
    - {id: harbor, description: Shared harbor panorama reused on both routes,
       variants: [{id: afternoon, description: Day lighting},
                  {id: twilight, description: Evening lighting}]}
    - {id: tower, description: Unique illustration concept for the tower}
''')
    first = story / 'milestones/accept-investigation.md'
    replace(first, '    - [event.find-cut-strap, event.present-evidence]\n', '')
    replace(first, '\n---\n#', '''
duration_minutes:
  narrative: {min_minutes: 10, max_minutes: 12}
  exploration: {min_minutes: 3, max_minutes: 5}
---
#''')
    last = story / 'milestones/fleet-warned.md'
    replace(last, '\n---\n#', '''
duration_minutes:
  narrative: {min_minutes: 100, max_minutes: 110}
  exploration: {min_minutes: 5, max_minutes: 6}
route_estimates:
  - events: [event.bell-restored]
    difference: Shared repair makes the first playthrough shorter
    duration_minutes:
      narrative: {min_minutes: 98, max_minutes: 110}
  - events: [event.horn-warning]
    difference: Solo warning adds a longer investigation and dialogue
    duration_minutes:
      narrative: {min_minutes: 200, max_minutes: 230}
      exploration: {min_minutes: 12, max_minutes: 18}
---
#''')
    for name in ('mara', 'ivo'):
        replace(story / f'characters/{name}.md', 'decisions: []\n',
                'decisions: []\nartwork_tier: main\n')
    replace(story / 'characters/nessa.md', 'decisions: []\n',
            'decisions: []\nartwork_tier: supporting\n')

    for ending, event in [('bell', 'event.bell-restored'),
                          ('horn', 'event.horn-warning')]:
        (story / 'authored-content' / f'{ending}-exclusive.md').write_text(f'''---
schema: '0.1'
type: authored-content
id: authored-content.{ending}-exclusive
title: {ending.capitalize()} route exclusive content
status: draft
decisions: []
events: [{event}]
revelations: []
---
Unique ending prose only present on the {ending} route.
''', encoding='utf-8')

    # Both endings reconverge through one shared Event without erasing the
    # distinct Facts/Relationships reached by their different Choice branches.
    (story / 'events/epilogue.md').write_text('''---
schema: '0.1'
type: event
id: event.epilogue
title: Shared epilogue
status: draft
decisions: []
participants: []
arcs: []
consequences: [Both routes lead to a warning that reaches the fleet]
after: [event.bell-restored, event.horn-warning]
prerequisites:
  any_of:
    - {completed: [event.bell-restored], not_completed: []}
    - {completed: [event.horn-warning], not_completed: []}
steps: []
---
The surviving fleet reaches safe harbor regardless of who sounded the warning.
''', encoding='utf-8')
    (story / 'milestones/epilogue.md').write_text('''---
schema: '0.1'
type: milestone
id: milestone.epilogue
title: Shared epilogue
status: draft
decisions: []
change: The warning resolves into safety on both branches.
arcs: [arc.stolen-warning]
fulfillment: {any_of: [[event.epilogue]]}
duration_minutes:
  narrative: {min_minutes: 0, max_minutes: 0}
  exploration: {min_minutes: 0, max_minutes: 0}
---
Both routes close the harbor incident with the same scene; zero is explicitly estimated.
''', encoding='utf-8')
    (story / 'authored-content/epilogue.md').write_text('''---
schema: '0.1'
type: authored-content
id: authored-content.epilogue
title: Shared epilogue prose
status: draft
decisions: []
events: [event.epilogue]
revelations: []
---
One reusable ending scene after both branches converge.
''', encoding='utf-8')

    before = fingerprint(story)
    first_run = invoke()
    data = first_run['metrics']
    assert invoke()['metrics'] == data
    assert fingerprint(story) == before
    assert not (root / 'no-config').exists()
    assert data['metricsVersion'] == 1 and data['catalogSourceRevision']
    previous_last = last.read_text()
    replace(last, 'max_minutes: 230', 'max_minutes: 231')
    changed_estimates = invoke()['metrics']
    assert changed_estimates['catalogSourceRevision'] != data['catalogSourceRevision']
    assert {r['id'] for r in changed_estimates['routes']} == {r['id'] for r in data['routes']}
    last.write_text(previous_last)
    assert data['routeCoverage']['status'] == 'bounded-complete', data['routeCoverage']
    assert data['routeCoverage']['truncated'] is False
    assert data['routeBounds']['status'] == 'declared-exhaustive'
    routes = data['routes']
    assert routes and all(r['status'] == 'structurally-reachable' for r in routes)
    assert len({r['id'] for r in routes}) == len(routes)
    assert all(len(r['milestones']) == 3 for r in routes)
    assert all('event.epilogue' in r['completedEvents'] for r in routes)
    assert all(len(set(r['completedEvents'])) == len(r['completedEvents']) for r in routes)
    selected = lambda route, id: next(m for m in route['milestones'] if m['milestoneId'] == id)
    assert {selected(r, 'milestone.fleet-warned')['alternative'] for r in routes} == {0, 1}
    assert all(selected(r, 'milestone.accept-investigation')['alternative'] == 0
               for r in routes)
    assert any(r['totalMinutes']['min_minutes'] < 120 for r in routes)
    assert any(r['totalMinutes']['min_minutes'] > 200 for r in routes)
    assert all(r['totalMinutes']['max_minutes'] <= 265 for r in routes)
    assert any(selected(r, 'milestone.fleet-warned')['difference'] for r in routes)
    bounds = data['routeBounds']['guaranteedMinutes']
    assert bounds and bounds['min_minutes'] < 120 and bounds['max_minutes'] > 230
    assert data['stateDivergences']
    assert any(d['predicate']['kind'] == 'relationship' for d in data['stateDivergences'])

    footprint = data['contentFootprint']
    assert footprint['distinctAuthoredContentCount'] == 6
    assert footprint['illustrationConceptCount'] == 2
    assert footprint['illustrationVariantCount'] == 2
    assert footprint['routeIllustrationAssignment'] == 'unverified'
    assert set(footprint['routeExclusiveContentIds']) == {
        'authored-content.bell-exclusive', 'authored-content.horn-exclusive'}
    assert {'authored-content.quay', 'authored-content.tower', 'authored-content.well',
            'authored-content.epilogue'} <= (
        set(footprint['sharedContentIds']))
    assert all(len(set(r['authoredContentIds'])) == len(r['authoredContentIds']) for r in routes)
    assert all(len(r['authoredContentIds']) < footprint['distinctAuthoredContentCount']
               for r in routes)
    # Choice frequency and number of engine Rooms are not used to count Content.
    assert footprint['characterArtworkTiers']['main']['count'] == 2
    assert footprint['characterArtworkTiers']['supporting']['count'] == 1

    budget = data['budgetFindings']
    by_dimension = {}
    for finding in budget:
        by_dimension.setdefault(finding['dimension'], []).append(finding)
    assert by_dimension['illustrated-backgrounds'][0]['status'] == 'soft-overage'
    assert by_dimension['illustrated-backgrounds'][0]['severity'] == 'warning'
    assert by_dimension['background-variants'][0]['status'] == 'within-budget'
    assert by_dimension['character-artwork-main'][0]['status'] == 'hard-violation'
    assert by_dimension['character-artwork-main'][0]['severity'] == 'error'
    assert by_dimension['character-artwork-supporting'][0]['status'] == 'soft-overage'
    assert {'target-risk', 'target-overrun'} <= {
        d['status'] for d in by_dimension['first-playthrough']}, by_dimension['first-playthrough']

    # Missing estimates never become zero; a bounded catalog still lists routes
    # and witnessed Content, but cannot claim complete playtime bounds.
    previous = last.read_text()
    replace(last, '      exploration: {min_minutes: 12, max_minutes: 18}\n', '')
    replace(last, '  exploration: {min_minutes: 5, max_minutes: 6}\n', '')
    partial = invoke()['metrics']
    assert any(r['totalMinutes'] is None for r in partial['routes'])
    assert partial['routeBounds']['guaranteedMinutes'] is None
    assert any(d['status'] == 'unverified' for d in partial['budgetFindings']
               if d['dimension'] == 'first-playthrough')
    last.write_text(previous)

    # Impossible typed references fail closed, rather than inventing routes.
    previous = last.read_text()
    replace(last, 'events: [event.bell-restored]', 'events: [event.not-real]')
    invalid = invoke(code=1)
    assert 'routes' not in invalid['metrics']
    assert any(d['code'] == 'schema' for d in invalid['diagnostics'])
    last.write_text(previous)

    # A contradictory/nonexclusive selection cannot silently choose one route.
    previous = first.read_text()
    replace(first, '    - [event.inspection-permitted]\n',
            '    - [event.inspection-permitted]\n'
            '    - [event.find-cut-strap, event.present-evidence]\n')
    ambiguous = invoke()['metrics']
    assert ambiguous['routeCoverage']['status'] == 'unverified'
    assert ambiguous['routeCoverage']['unsupportedHistories'] > 0
    assert ambiguous['routeBounds']['guaranteedMinutes'] is None
    first.write_text(previous)

    for args in [('not-an-option',), ('--base', 'HEAD')]:
        assert invoke(code=2, extra=args)['diagnostics'][0]['code'] == 'CLI_USAGE'

    assert invoke()['metrics'] == data
    assert fingerprint(story) == before

    # Identical fulfillment selectors are one shared time segment; a different
    # selector overlapping the same Event cannot be safely apportioned.
    epilogue = story / 'milestones/epilogue.md'
    original_epilogue = epilogue.read_text()
    replace(epilogue, 'narrative: {min_minutes: 0, max_minutes: 0}',
            'narrative: {min_minutes: 3, max_minutes: 3}')
    duplicate = story / 'milestones/revisit.md'
    duplicate.write_text('''---
schema: '0.1'
type: milestone
id: milestone.revisit
title: The same shared scene, referenced twice
status: draft
decisions: []
change: This milestone reuses the epilogue as a fulfillment witness.
arcs: [arc.stolen-warning]
fulfillment: {any_of: [[event.epilogue]]}
duration_minutes:
  narrative: {min_minutes: 3, max_minutes: 3}
  exploration: {min_minutes: 0, max_minutes: 0}
---
The shared event is one physical story segment, not two separate scenes.
''', encoding='utf-8')
    deduplicated = invoke()['metrics']
    assert any(m['accounting'] == 'shared-deduplicated'
               for route in deduplicated['routes'] for m in route['milestones'])
    mins = lambda result: sorted({r['totalMinutes']['min_minutes'] for r in result['routes']})
    assert mins(deduplicated) == [x + 3 for x in mins(data)]
    previous_last = last.read_text()
    replace(last, '    - [event.horn-warning]\n', '')
    replace(last, '''  - events: [event.horn-warning]
    difference: Solo warning adds a longer investigation and dialogue
    duration_minutes:
      narrative: {min_minutes: 200, max_minutes: 230}
      exploration: {min_minutes: 12, max_minutes: 18}
''', '')
    linear = invoke()['metrics']
    assert linear['route']['status'] == 'provisional-single-alternative'
    assert linear['route']['totalMinutes'] == {'min_minutes': 119.0,
                                               'max_minutes': 136.0}
    assert linear['coverage']['routeTotalAvailable'] is True

    # Unrelated incompleteness must not restore the previously double-counted
    # milestone sum. Supported histories still deduplicate the shared epilogue,
    # but incomplete search is not proof of a unique Story-wide route total.
    epilogue_event = story / 'events/epilogue.md'
    original_event = epilogue_event.read_text()
    replace(epilogue_event, 'status: draft\n', 'status: draft\ncompleteness: partial\n')
    incomplete = invoke()['metrics']
    assert incomplete['routeCoverage']['status'] == 'unverified'
    assert incomplete['routes'] and any(r['totalMinutes'] is not None
                                         for r in incomplete['routes'])
    assert incomplete['route']['totalMinutes'] is None
    assert incomplete['coverage']['routeTotalAvailable'] is False
    epilogue_event.write_text(original_event)

    # Partially shared Event selectors cannot be apportioned and must not
    # leave a stale 'routeTotalAvailable' flag from the original naive sum.
    replace(duplicate, '[[event.epilogue]]',
            '[[event.epilogue, event.inspection-permitted]]')
    overlapping = invoke()['metrics']
    assert any(m['accounting'] == 'unverified-overlap'
               for route in overlapping['routes'] for m in route['milestones'])
    assert all(r['totalMinutes'] is None for r in overlapping['routes'])
    assert overlapping['routeBounds']['guaranteedMinutes'] is None
    assert overlapping['route']['totalMinutes'] is None
    assert overlapping['coverage']['routeTotalAvailable'] is False
    last.write_text(previous_last)
    duplicate.unlink()
    epilogue.write_text(original_epilogue)
    assert invoke()['metrics'] == data

    # An independent Event explosion exceeds the bounded solver. Its sampled
    # histories remain evidence, not exhaustive timing or exclusivity claims.
    for index in range(13):
        (story / 'events' / f'independent-{index}.md').write_text(f'''---
schema: '0.1'
type: event
id: event.independent-{index}
title: Optional independent event {index}
status: draft
decisions: []
participants: []
arcs: []
consequences: [Optional independent discovery]
after: []
prerequisites:
  any_of:
    - {{completed: [], not_completed: []}}
steps: []
---
The player may witness optional discovery {index}.
''', encoding='utf-8')
    crowded = invoke()['metrics']
    assert crowded['routeCoverage']['status'] == 'unverified', crowded['routeCoverage']
    assert crowded['routeCoverage']['truncated'] is True
    assert crowded['routeBounds']['guaranteedMinutes'] is None
    assert crowded['contentFootprint']['classificationCoverage'] == 'unverified'
    assert all(d['status'] == 'unverified' for d in crowded['budgetFindings']
               if d['dimension'] == 'first-playthrough')
    print('Native route-specific duration, causal state, distinct Content and budgets passed.')
