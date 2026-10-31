"""Public native CLI narrative-to-Project coverage and read-only evidence contract."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary, source = map(lambda value: Path(value).resolve(), sys.argv[1:3])


def snapshot(path):
    return {str(p.relative_to(path)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in path.rglob('*') if p.is_file()}


with tempfile.TemporaryDirectory(prefix='noveltea-coverage-') as tmp:
    root = Path(tmp)
    story = root / 'story'
    project = root / 'game'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', story)

    def call(*args, code=0):
        result = subprocess.run([str(binary), '--json', '--no-daemon', *map(str, args)],
                                capture_output=True, text=True, cwd=root)
        assert result.returncode == code and not result.stderr, (args, result)
        value = json.loads(result.stdout)
        assert value['exitCode'] == code and value['protocolVersion'] == 1
        return value

    def coverage(*options, code=0):
        return call('narrative', 'coverage', story, '--project', project, *options, code=code)

    call('project', 'create', project, '--name', 'Coverage Fixture')
    for family, record_id in [('rooms', 'start'), ('variables', 'permission'),
                              ('scenes', 'reveal'), ('dialogues', 'trial'),
                              ('tests', 'permission-proof')]:
        call('--project', project, 'entity', 'create', family, record_id)
    (project / 'project.yaml').open('a').write('\nentrypoint:\n  kind: room\n  id: start\n')
    variable = project / 'records/variables/permission.yaml'
    variable.write_text('id: permission\nlabel: Permission\ndata:\n  type: boolean\n  value: false\n')
    scene = project / 'records/scenes/reveal.yaml'
    scene.write_text("""id: reveal
label: Grant inspection
narrativeRefs: [event.question-ivo, milestone.accept-investigation]
data:
  displayName: Grant inspection
  stage:
    kind: inherited
  events:
    - id: grant
      label: Grant permission
      narrativeRefs: [event.question-ivo]
      timeline:
        trackId: main
        startMs: 0
        durationMs: 0
      type: gameplay-effect-batch
      operations:
        - id: grant-permission
          kind: set-global-property
          variable: permission
          value: true
  terminal:
    kind: return
    outcome: null
""")
    dialogue = project / 'records/dialogues/trial.yaml'
    dialogue.write_text("""id: trial
label: Question the witness
narrativeRefs: [event.question-ivo]
data:
  displayName: Question the witness
  settings:
    showDisabledChoices: false
    logMode: only-choices
  entryBlockId: intro
  blocks:
    - id: intro
      type: choice
      label: Ask
    - id: done
      type: sequence
      label: End
      segments: []
  edges:
    - id: say-truth
      kind: choice
      fromBlockId: intro
      toBlockId: done
      narrativeRefs: [choice-point.question-ivo, event.question-ivo]
      label:
        source:
          kind: inline
          text: Tell the truth
        markup: plain
      effects: []
      logged: true
      autosaveSafePoint: false
  completion:
    kind: scene
    id: reveal
""")
    test = project / 'records/tests/permission-proof.yaml'
    test.write_text('narrativeRefs: [event.question-ivo]\n' + test.read_text())

    before = (snapshot(story), snapshot(project))
    result = coverage()
    report = result['coverage']
    records = {record['id']: record for record in report['requirements']}
    assert report['contractRevision']
    assert records['event.question-ivo']['association'] == 'draft-only', records['event.question-ivo']
    claim = records['choice-point.question-ivo']['claims'][0]
    assert (claim['collection'], claim['recordId']) == ('dialogues', 'trial')
    assert claim['subrecord'] == {'kind': 'dialogue-edge', 'id': 'say-truth',
                                  'operation': 'choice', 'fromBlockId': 'intro',
                                  'toBlockId': 'done', 'completionSceneId': 'reveal'}
    assert claim['sourcePath'] == 'records/dialogues/trial.yaml'
    assert claim['line'] > 0 and claim['column'] > 0
    scene_claim = next(c for c in records['event.question-ivo']['claims']
                       if c['collection'] == 'scenes' and c['subrecord'])
    assert scene_claim['subrecord']['id'] == 'grant'
    assert scene_claim['subrecord']['operation'] == 'gameplay-effect-batch'
    assert len(report['routeCandidates']) == 1, report['routeCandidates']
    route = report['routeCandidates'][0]
    assert route['choicePointId'] == 'choice-point.question-ivo'
    assert route['eventId'] == 'event.question-ivo'
    assert route['choiceEdge'] == claim and route['sceneEffect'] == scene_claim
    assert route['status'] == 'declared-unverified'
    assert route['reachabilityVerified'] is False and route['stateEffectVerified'] is False
    assert report['routeCandidatesTruncated'] is False
    assert records['event.question-ivo']['tests'][0]['execution'] == 'not-observed'
    assert records['event.question-ivo']['behaviorVerified'] is False
    assert records['event.question-ivo']['presentationAssessment'] == 'not-assessed'
    assert records['event.bell-restored']['association'] == 'unmapped'
    assert result['diagnostics'] == []
    assert coverage()['coverage'] == report
    assert (snapshot(story), snapshot(project)) == before
    print('Narrative coverage resolves choice edges, Scene effects and unverified Tests without writes.')

    story_event = story / 'events/question-ivo.md'
    original_event = story_event.read_text()
    story_event.write_text(original_event.replace('status: draft', 'status: approved', 1))
    approved = coverage()['coverage']
    assert next(r for r in approved['requirements']
                if r['id'] == 'event.question-ivo')['association'] == 'claimed-unverified'
    story_event.write_text(original_event)

    test_report = root / 'test-run.json'
    reported = {
        # A legitimate Project root can use native Windows backslashes,
        # forward slashes, and redundant path components independently of
        # the CLI's generic-string path presentation.
        'projectRoot': project.as_posix() + '/./',
        'native': {'report': {'entries': [{'id': 'permission-proof', 'status': 'passed'}]}}
    }
    test_report.write_text(json.dumps(reported))
    attached = coverage('--test-report', test_report)['coverage']
    evidence = next(r for r in attached['requirements'] if r['id'] == 'event.question-ivo')['tests'][0]
    assert evidence['execution'] == 'externally-reported', evidence
    assert evidence['reportedStatus'] == 'passed' and evidence['provenanceVerified'] is False
    assert next(r for r in attached['requirements']
                if r['id'] == 'event.question-ivo')['behaviorVerified'] is False
    # The native path spelling used by Windows Test runners must work too.
    reported['projectRoot'] = str(project)
    test_report.write_text(json.dumps(reported))
    native_spelling = coverage('--test-report', test_report)['coverage']
    native_evidence = next(r for r in native_spelling['requirements']
                           if r['id'] == 'event.question-ivo')['tests'][0]
    assert native_evidence['execution'] == 'externally-reported', native_evidence
    # An unrelated existing Project must not receive another Project's evidence.
    (root / 'other-project').mkdir()
    reported['projectRoot'] = str(root / 'other-project')
    test_report.write_text(json.dumps(reported))
    unrelated = coverage('--test-report', test_report)['coverage']
    unrelated_evidence = next(r for r in unrelated['requirements']
                              if r['id'] == 'event.question-ivo')['tests'][0]
    assert unrelated_evidence['execution'] == 'not-observed', unrelated_evidence
    assert unrelated_evidence.get('reportedStatus') is None
    # Relative report paths are not authoritative Project identities, even if
    # the CLI's current working directory could resolve them to this Project.
    reported['projectRoot'] = 'game'
    test_report.write_text(json.dumps(reported))
    relative = coverage('--test-report', test_report)['coverage']
    relative_evidence = next(r for r in relative['requirements']
                             if r['id'] == 'event.question-ivo')['tests'][0]
    assert relative_evidence['execution'] == 'not-observed', relative_evidence

    dialogue.write_text(dialogue.read_text().replace(
        '[choice-point.question-ivo, event.question-ivo]',
        '[choice-point.question-ivo, choice-point.question-ivo, event.no-such-event]'))
    changes = coverage()['coverage']
    assert len(changes['duplicate']) == 1, changes['duplicate']
    assert changes['dangling'][0]['targetId'] == 'event.no-such-event'
    assert changes['duplicate'][0]['line'] > 0
    duplicate_story = story / 'events/duplicate-question.md'
    shutil.copy2(story_event, duplicate_story)
    ambiguous = coverage(code=1)['coverage']['ambiguous']
    assert ambiguous and all(c['targetId'] == 'event.question-ivo' for c in ambiguous)
    duplicate_story.unlink()
    assert coverage('--test-report', story / 'not-a-report.json', code=1)['diagnostics'][0][
        'code'] == 'coverage.test-report-invalid'
    scene.write_text(scene.read_text().replace(
        'narrativeRefs: [event.question-ivo, milestone.accept-investigation]',
        'narrativeRefs: event.question-ivo'))
    assert any(d['code'] == 'coverage.project-invalid'
               for d in coverage(code=1)['diagnostics'])
    assert call('narrative', 'coverage', story, code=2)['diagnostics'][0][
        'code'] == 'CLI_USAGE'
    print('Dangling, duplicate and malformed external evidence reporting passed.')
