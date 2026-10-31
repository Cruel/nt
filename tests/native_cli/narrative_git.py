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
    # A global switch must not interrupt parsing a command-local value pair.
    for command in [
        ['narrative', 'validate', str(story), '--base', base, '--json'],
        ['narrative', 'validate', str(story), '--base', '--json', base],
    ]:
        positioned = subprocess.run([str(binary), *command], cwd=repo,
                                    capture_output=True, text=True)
        assert positioned.returncode == 0 and positioned.stderr == '', positioned
        assert json.loads(positioned.stdout) == untouched
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

    # A commit whose tree lists an unreadable Story blob is not an empty baseline.
    # Build a detached test commit containing a missing blob without altering HEAD.
    missing_blob = 'f' * 40
    missing_tree = subprocess.run(
        ['git', '-C', str(independent), 'mktree', '--missing'],
        input=f'100644 blob {missing_blob}\tmissing.md\n',
        capture_output=True, text=True)
    assert missing_tree.returncode == 0, missing_tree.stderr
    missing_commit = git(independent, 'commit-tree', missing_tree.stdout.strip(),
                         '-m', 'Tree references unreadable Story data')
    unreadable = invoke(independent, independent, '--base', missing_commit, code=1)
    assert any(d['code'] == 'baseline-invalid' for d in unreadable['diagnostics'])
    assert unreadable['catalog']['protection']['status'] == 'unavailable'
    assert git(independent, 'rev-parse', 'HEAD') == standalone_sha

    # Valid commits predating Story authoring are empty baselines, even if the
    # Story directory did not exist or had only non-Markdown files at that SHA.
    for initial_files in (False, True):
        fresh = repo.parent / ('empty-story-tree' if initial_files else 'empty-git-tree')
        fresh.mkdir()
        git(fresh, 'init', '-q')
        git(fresh, 'config', 'user.name', 'Test Author')
        git(fresh, 'config', 'user.email', 'test@example.invalid')
        if initial_files:
            (fresh / 'README.md').write_text('Repository documentation only\n')
            inbox = fresh / 'game' / 'story' / '.story-inbox' / 'ideas'
            inbox.mkdir(parents=True)
            (inbox / 'private.yaml').write_text('private: author-only idea\n')
            (inbox / 'private.md').write_text('Private note without Story frontmatter\n')
            (fresh / 'game' / 'story' / 'notes.txt').write_text('No Story Markdown yet\n')
            git(fresh, 'add', '.')
        git(fresh, 'commit', '-qm', 'Before Story creation', '--allow-empty')
        empty_sha = git(fresh, 'rev-parse', 'HEAD')
        fresh_story = fresh / 'game' / 'story'
        shutil.copytree(source / 'tests/fixtures/narrative/reference-story', fresh_story,
                        dirs_exist_ok=True)
        before_story = snapshot(fresh_story)
        before_index = git(fresh, 'ls-files', '--stage')
        created = invoke(fresh, fresh_story, '--base', empty_sha)
        catalog = created['catalog']
        protection = catalog['protection']
        all_ids = {record['metadata']['id'] for record in catalog['records']}
        assert created['diagnostics'] == []
        assert '.story-inbox' not in json.dumps(created)
        assert protection['status'] == 'checked' and protection['base'] == empty_sha
        assert protection['checkedDecisions'] == 0 and protection['findings'] == []
        assert set(protection['impact']['changed']) == all_ids and all_ids
        assert len(protection['impact']['affected']) == len(all_ids)
        assert protection['impact']['moved'] == []
        assert protection['complete'] is True and protection['authorizationVerified'] is False
        assert catalog['authorization']['status'] == 'unchanged'
        assert catalog['authorization']['verified'] is False
        assert snapshot(fresh_story) == before_story
        assert git(fresh, 'ls-files', '--stage') == before_index
        assert git(fresh, 'rev-parse', 'HEAD') == empty_sha

        # An empty historical snapshot does not excuse malformed current Story.
        candidate = fresh_story / 'milestones' / 'accept-investigation.md'
        original_candidate = candidate.read_bytes()
        update(candidate, "schema: '0.1'", "schema: '0.0'")
        broken = invoke(fresh, fresh_story, '--base', empty_sha, code=1)
        assert any(d['code'] == 'schema' for d in broken['diagnostics'])
        assert broken['catalog']['protection']['status'] == 'checked'
        assert broken['catalog']['protection']['complete'] is False
        assert broken['catalog']['authorization']['status'] == 'indeterminate'
        candidate.write_bytes(original_candidate)

        # After Story is committed, its protected decisions must still require
        # human review if subsequently modified; empty history grants no waiver.
        update(candidate, 'authority: delegated', 'authority: user-protected')
        git(fresh, 'add', 'game/story')
        git(fresh, 'commit', '-qm', 'Introduce protected Story decisions')
        protected_sha = git(fresh, 'rev-parse', 'HEAD')
        update(candidate, 'permission rather than trespass',
               'trespass rather than permission')
        protected_change = invoke(fresh, fresh_story, '--base', protected_sha, code=1)
        assert protected_change['diagnostics'] == []
        assert protected_change['catalog']['protection']['status'] == 'checked'
        assert protected_change['catalog']['protection']['findings'][0]['category'] == 'changed'
        assert protected_change['catalog']['authorization']['status'] == 'approval-required'
        assert protected_change['catalog']['authorization']['verified'] is False

    print('Native Git baseline protection, empty history, impact, moves and read-only failures passed.')
