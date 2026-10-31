"""End-to-end native Git-baseline protection and impact acceptance."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()
source = Path(sys.argv[2]).resolve()


def git(repo, *args):
    run = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    assert run.returncode == 0, (args, run.stderr)
    return run.stdout.strip()


def invoke(repo, story, *args, code=0):
    run = subprocess.run([str(binary), '--json', 'narrative', 'validate', str(story), *args],
                         cwd=repo, env={**os.environ, 'NOVELTEA_USER_CONFIG_ROOT': str(repo / 'no-config')},
                         capture_output=True, text=True)
    assert run.returncode == code, (args, run.returncode, run.stdout, run.stderr)
    assert not run.stderr, run.stderr
    output = json.loads(run.stdout)
    assert output['protocolVersion'] == 1
    assert output['success'] == (code == 0)
    return output


def snapshot(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob('*.md') if not path.is_symlink()}


def update(path, before, after):
    text = path.read_text(encoding='utf-8')
    assert before in text, (path, before)
    path.write_text(text.replace(before, after), encoding='utf-8')


with tempfile.TemporaryDirectory(prefix='nt-narrative-git-') as temporary:
    repo = Path(temporary) / 'worktree with spaces'
    repo.mkdir()
    story = repo / 'game' / 'story'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', story)
    milestone = story / 'milestones' / 'accept-investigation.md'
    update(milestone, 'authority: delegated', 'authority: user-protected')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.name', 'Test Author')
    git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Seed trusted Story')
    base = git(repo, 'rev-parse', 'HEAD')
    original = milestone.read_bytes()
    seed_snapshot = snapshot(story)
    seed_index = git(repo, 'ls-files', '--stage')

    untouched = invoke(repo, story, '--base', base)
    protection = untouched['catalog']['protection']
    assert protection['status'] == 'checked' and protection['base'] == base
    assert protection['checkedDecisions'] == 1 and protection['findings'] == []
    assert protection['impact']['changed'] == [] and protection['impact']['moved'] == []
    assert untouched['catalog']['authorization']['status'] == 'unchanged'
    assert not (repo / 'no-config').exists()
    assert snapshot(story) == seed_snapshot and git(repo, 'ls-files', '--stage') == seed_index

    # Stable IDs survive filename moves; a path-only rename is not a protected edit.
    moved = story / 'other' / 'renamed-milestone.md'
    moved.parent.mkdir()
    milestone.rename(moved)
    moved_report = invoke(repo, story, '--base', base)['catalog']['protection']
    assert moved_report['findings'] == [] and moved_report['impact']['changed'] == []
    assert moved_report['impact']['moved'] == [{
        'id': 'milestone.accept-investigation',
        'previousPath': 'milestones/accept-investigation.md',
        'path': 'other/renamed-milestone.md',
    }]
    moved.rename(milestone)
    moved.parent.rmdir()

    # Prose edits are impact candidates, not permission findings.
    update(milestone, 'The opening threshold is permission to act',
           'The opening threshold is an expressly granted right to act')
    prose = invoke(repo, story, '--base', base)['catalog']['protection']
    assert prose == invoke(repo, story, '--base', base)['catalog']['protection']
    assert prose['findings'] == []
    assert prose['impact']['changed'] == ['milestone.accept-investigation']
    by_id = {item['id']: item for item in prose['impact']['affected']}
    for target in ('event.inspection-permitted', 'event.present-evidence',
                   'puzzle.tower-access', 'choice-point.question-ivo',
                   'authored-content.tower'):
        assert target in by_id, target
        assert by_id[target]['witnesses'] and by_id[target]['reason'] == 'linked-dependency-review'

    # Staged, unstaged and untracked Story records are all observed from the filesystem.
    git(repo, 'add', 'game/story/milestones/accept-investigation.md')
    new = story / 'events' / 'untracked.md'
    sample = (story / 'events' / 'inspection-permitted.md').read_text()
    new.write_text(sample.replace('event.inspection-permitted', 'event.untracked')
                   .replace('title: ', 'title: Untracked '), encoding='utf-8')
    with_untracked = invoke(repo, story, '--base', base)['catalog']['protection']
    assert {'milestone.accept-investigation', 'event.untracked'} <= set(with_untracked['impact']['changed'])
    new.unlink()
    milestone.write_bytes(original)

    update(milestone, 'permission rather than trespass', 'trespass rather than permission')
    changed = invoke(repo, story, '--base', base, code=1)
    assert changed['diagnostics'] == []  # Authorization is distinct from structural failure.
    assert changed['catalog']['authorization']['status'] == 'approval-required'
    finding = changed['catalog']['protection']['findings'][0]
    assert finding['code'] == 'protected-decision-change'
    assert finding['decisionId'] == 'milestone.accept-investigation#permission-threshold'
    assert finding['category'] == 'changed'
    assert finding['beforeLocation']['path'] == 'milestones/accept-investigation.md'
    assert finding['afterLocation']['pointer'].startswith('/decisions/0')
    assert finding['before']['authority'] == finding['after']['authority'] == 'user-protected'
    assert milestone.read_text().find('trespass rather than permission') >= 0

    milestone.write_bytes(original)
    update(milestone, 'authority: user-protected', 'authority: delegated')
    demoted = invoke(repo, story, '--base', base, code=1)
    assert demoted['catalog']['protection']['findings'][0]['category'] == 'demoted'

    milestone.write_bytes(original)
    update(milestone, 'status: draft', 'status: superseded')
    retired = invoke(repo, story, '--base', base, code=1)
    assert retired['catalog']['protection']['findings'][0]['category'] == 'record-retired'

    milestone.write_bytes(original)
    milestone.unlink()
    deleted = invoke(repo, story, '--base', base, code=1)
    assert deleted['catalog']['protection']['findings'][0]['category'] == 'record-deleted'
    assert 'milestone.accept-investigation' in deleted['catalog']['protection']['impact']['changed']
    milestone.write_bytes(original)

    # Invalid working metadata must never yield a misleading 'unchanged' verdict.
    update(milestone, "schema: '0.1'", "schema: '0.0'")
    invalid_current = invoke(repo, story, '--base', base, code=1)
    assert any(d['code'] == 'schema' for d in invalid_current['diagnostics'])
    assert invalid_current['catalog']['authorization']['status'] == 'indeterminate'
    assert invalid_current['catalog']['protection']['complete'] is False
    milestone.write_bytes(original)

    # A structurally invalid historical record must never be silently ignored.
    update(milestone, "schema: '0.1'", "schema: '0.0'")
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'Invalid historical schema')
    invalid_base = git(repo, 'rev-parse', 'HEAD')
    milestone.write_bytes(original)
    invalid = invoke(repo, story, '--base', invalid_base, code=1)
    assert any(d['code'] == 'baseline-invalid' for d in invalid['diagnostics'])
    assert invalid['catalog']['protection']['status'] == 'unavailable'
    assert not invalid['catalog']['protection']['findings']

    bad_sha = invoke(repo, story, '--base', 'does-not-exist', code=1)
    assert any(d['code'] == 'baseline-invalid' for d in bad_sha['diagnostics'])
    for options in [('--base',), ('--base', base, '--permission-granted'),
                    ('--base', base, '--base', base)]:
        invoke(repo, story, *options, code=2)

    outside = repo.parent / 'not-git'
    outside.mkdir()
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', outside / 'story')
    no_git = invoke(outside, outside / 'story', '--base', base, code=1)
    assert any(d['code'] == 'baseline-invalid' for d in no_git['diagnostics'])
    assert invoke(outside, outside / 'story')['catalog']['authorization']['status'] == 'not-assessed'

    # A standalone Story repository can itself be the Git worktree root.
    independent = repo.parent / 'standalone-story-repo'
    shutil.copytree(source / 'tests/fixtures/narrative/reference-story', independent)
    git(independent, 'init', '-q')
    git(independent, 'config', 'user.name', 'Test Author')
    git(independent, 'config', 'user.email', 'test@example.invalid')
    git(independent, 'add', '.')
    git(independent, 'commit', '-qm', 'Standalone baseline')
    standalone_sha = git(independent, 'rev-parse', 'HEAD')
    independent_result = invoke(independent, independent, '--base', standalone_sha)
    assert independent_result['catalog']['protection']['base'] == standalone_sha
    assert independent_result['catalog']['protection']['impact']['changed'] == []
    print('Native Git baseline protection, impact witnesses, moves and read-only failures passed.')
