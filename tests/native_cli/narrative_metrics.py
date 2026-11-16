"""Canonical planning-metadata admission and read-only native Narrative metrics."""
import json
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()
source = Path(sys.argv[2]).resolve()


def modify(path, old, new):
    text = path.read_text()
    assert old in text, (path, old)
    path.write_text(text.replace(old, new, 1))


def snapshot(path):
    return {str(file.relative_to(path)): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in path.rglob('*') if file.is_file() and not file.is_symlink()}


with tempfile.TemporaryDirectory(prefix='nt-narrative-metrics-') as temporary:
    root = Path(temporary)
    story = root / 'story'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', story)
    env = dict(os.environ, NOVELTEA_USER_CONFIG_ROOT=str(root / 'forbidden-config'))

    def invoke(*args, code=0):
        run = subprocess.run([str(binary), '--json', *args], cwd=root, env=env,
                             capture_output=True, encoding='utf-8')
        assert run.returncode == code, (run.returncode, run.stdout, run.stderr)
        assert not run.stderr, run.stderr
        result = json.loads(run.stdout)
        assert result['protocolVersion'] == 1
        assert result['success'] == (code == 0)
        return result

    def metrics(code=0, *args):
        return invoke('narrative', 'metrics', str(story), *args, code=code)

    def expect_invalid(path, old, new, pointer, diagnostic='schema'):
        before = path.read_text()
        modify(path, old, new)
        actual = metrics(code=1)
        assert any(item['code'] == diagnostic and item['pointer'].startswith(pointer)
                   for item in actual['diagnostics']), actual['diagnostics']
        assert 'milestones' not in actual['metrics']
        assert invoke('narrative', 'validate', str(story), code=1)['diagnostics']
        path.write_text(before)

    initial_files = snapshot(story)
    baseline = metrics()['metrics']
    assert snapshot(story) == initial_files
    assert baseline['metricsVersion'] == 1
    assert baseline['coverage']['unresolvedAlternatives'] == 2
    assert baseline['route']['totalMinutes'] is None
    assert baseline['foundation']['approvedFirstPlaythroughMinutes'] is None

    direction = story / 'creative-direction/last-bell.md'
    modify(direction, 'status: draft', 'status: approved')
    planning = '''planning:
  choice_frequency: occasional
  choice_points: {min: 1, max: 3}
  branching: {depth: linear, route_exclusivity: none}
  puzzle_emphasis: adventure
  puzzle_count: {max: 2}
  pacing: balanced
  first_playthrough: {min_minutes: 20.5, max_minutes: 35.25}
  production:
    illustrated_backgrounds: {count: {min: 1, max: 2}, firmness: hard}
    background_variants: {count: {max: 1}, firmness: hard}
    character_artwork:
      main: {count: {max: 2}, firmness: soft}
  illustration_concepts:
    - id: harbor-view
      description: Reused harbor illustration, not an engine Room
      variants:
        - {id: twilight, description: A color variant of the same illustration}
'''
    modify(direction, 'main_arc: arc.stolen-warning\n',
           'main_arc: arc.stolen-warning\n' + planning)
    character = story / 'characters/mara.md'
    modify(character, 'motivation: Keep the departing',
           'artwork_tier: main\nmotivation: Keep the departing')
    puzzle = story / 'puzzles/tower-access.md'
    modify(puzzle, 'objective: Convince', 'mechanics: adventure\nobjective: Convince')

    first = story / 'milestones/accept-investigation.md'
    second = story / 'milestones/fleet-warned.md'
    modify(first, '    - [event.find-cut-strap, event.present-evidence]\n', '')
    modify(second, '    - [event.horn-warning]\n', '')
    modify(first, '\n---\n#', '''
duration_minutes:
  narrative: {min_minutes: 4, max_minutes: 6}
  exploration: {min_minutes: 2, max_minutes: 3}
route_estimates:
  - events: [event.inspection-permitted]
    difference: Faster exposition on the direct appeal route
    duration_minutes:
      narrative: {min_minutes: 4.5, max_minutes: 7}
---
#''')
    modify(second, '\n---\n#', '''
duration_minutes:
  narrative: {min_minutes: 10, max_minutes: 12}
  exploration: {min_minutes: 3, max_minutes: 4}
---
#''')

    positive = metrics()['metrics']
    assert positive['foundation']['targetCoverage'] == 'estimated'
    assert positive['foundation']['approvedFirstPlaythroughMinutes'] == (
        {'min_minutes': 20.5, 'max_minutes': 35.25})
    assert positive['foundation']['productionBudget']['illustrated_backgrounds']['count']['max'] == 2
    assert len(positive['foundation']['illustrationConcepts']) == 1
    assert positive['route']['status'] == 'provisional-single-alternative'
    assert positive['route']['narrativeMinutes'] == {'min_minutes': 14.5, 'max_minutes': 19.0}
    assert positive['route']['explorationMinutes'] == {'min_minutes': 5.0, 'max_minutes': 7.0}
    assert positive['route']['totalMinutes'] == {'min_minutes': 19.5, 'max_minutes': 26.0}
    assert positive['coverage']['missingNarrative'] == 0
    assert positive['coverage']['missingExploration'] == 0
    assert positive['milestones'][0]['estimateSource'] in ('route-override', 'milestone')
    assert positive['sourceRevisions']
    assert positive['contractRevision'] == baseline['contractRevision']
    assert positive['catalogSourceRevision'] != baseline['catalogSourceRevision']
    unchanged = snapshot(story)
    assert metrics()['metrics'] == positive
    assert snapshot(story) == unchanged
    original_character = character.read_text()
    modify(character, 'Mara is the player Character', 'Mara is the lead Character')
    body_change = metrics()['metrics']
    assert body_change['catalogSourceRevision'] != positive['catalogSourceRevision']
    assert body_change['route'] == positive['route']
    character.write_text(original_character)
    original_direction = direction.read_text()
    modify(direction, 'max: 3}', 'max: 3.0}')
    assert metrics()['metrics']['route']['totalMinutes'] == positive['route']['totalMinutes']
    direction.write_text(original_direction)
    assert invoke('narrative', 'validate', str(story))['catalog']['diagnostics'] == []
    assert not (root / 'forbidden-config').exists()

    positioned = subprocess.run(
        [str(binary), 'narrative', 'metrics', str(story), '--json', '--no-daemon'],
        cwd=root, env=env, capture_output=True, encoding='utf-8')
    assert positioned.returncode == 0 and positioned.stderr == ''
    assert json.loads(positioned.stdout)['metrics'] == positive

    # Missing estimates are not zero, even when other Milestones have estimates.
    before = second.read_text()
    modify(second, '  exploration: {min_minutes: 3, max_minutes: 4}\n', '')
    partial = metrics()['metrics']
    assert partial['coverage']['missingExploration'] == 1
    assert partial['route']['explorationMinutes'] is None
    assert partial['route']['totalMinutes'] is None
    assert partial['route']['narrativeMinutes'] is not None
    second.write_text(before)

    expect_invalid(direction, 'max_minutes: 35.25', 'max_minutes: 15',
                   '/planning/first_playthrough/max_minutes')
    expect_invalid(direction, 'max: 3}', 'max: -3}', '/planning/choice_points/max')
    expect_invalid(direction, 'max: 3}', 'max: 2.5}', '/planning/choice_points/max')
    expect_invalid(direction, 'puzzle_emphasis: adventure', 'puzzle_emphasis: none',
                   '/planning/puzzle_count')
    expect_invalid(direction, 'route_exclusivity: none', 'route_exclusivity: substantial',
                   '/planning/branching/route_exclusivity')
    expect_invalid(direction, 'pacing: balanced', 'pacing: unknown', '/planning/pacing')
    expect_invalid(direction, planning, 'planning: {}\n', '/planning')
    expect_invalid(direction, '  pacing: balanced', '  pacing: balanced\n  unsupported: 1',
                   '/planning/unsupported')
    expect_invalid(direction, 'max: 1}, firmness: hard', 'max: 0}, firmness: hard',
                   '/planning/illustration_concepts')
    expect_invalid(direction, '  - id: harbor-view', '''  - id: harbor-view
      description: Duplicate illustration concept
    - id: harbor-view''', '/planning/illustration_concepts')
    expect_invalid(first, 'max_minutes: 7', 'max_minutes: 3',
                   '/route_estimates/0/duration_minutes/narrative/max_minutes')
    expect_invalid(first, 'events: [event.inspection-permitted]',
                   'events: [event.bell-restored]', '/route_estimates/0/events')
    expect_invalid(first, '    difference: Faster exposition on the direct appeal route\n',
                   '    difference: Faster exposition on the direct appeal route\n'
                   '  - events: [event.inspection-permitted]\n'
                   '    difference: Duplicate route estimate\n', '/route_estimates/1/events')
    expect_invalid(direction, 'min_minutes: 20.5', 'min_minutes: .inf',
                   '', diagnostic='yaml')

    for args in [(), ('--base', 'HEAD'), ('--unknown',), ('extra',)]:
        result = metrics(2, *args) if args else invoke('narrative', 'metrics', code=2)
        assert result['diagnostics'][0]['code'] == 'CLI_USAGE'
    assert invoke('--project', str(root), 'narrative', 'metrics', str(story),
                  code=2)['diagnostics'][0]['code'] == 'CLI_USAGE'

    # Route totals do not establish source authorization or mutable engine Rooms.
    assert metrics()['metrics'] == positive
    assert not (root / 'forbidden-config').exists()
    print('Native Narrative planning metadata, route metrics, read-only and negative cases passed.')
