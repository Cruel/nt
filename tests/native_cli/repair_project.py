"""#616: certify candidate repair through the relocated public native CLI."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary = Path(sys.argv[1]).resolve()

with tempfile.TemporaryDirectory(prefix='noveltea-repair-cli-') as temporary:
    scratch = Path(temporary)
    installed = scratch / binary.name
    shutil.copy2(binary, installed)
    env = {**os.environ, 'PATH': str(scratch), 'NOVELTEA_NO_DAEMON': '1'}

    def run(*args, cwd=scratch, environment=env):
        return subprocess.run([str(installed), *args], env=environment, cwd=cwd,
                              capture_output=True, text=True, timeout=90)

    def reply(*args, code=0, cwd=scratch, environment=env):
        process = run('--json', *args, cwd=cwd, environment=environment)
        assert process.returncode == code, (args, process)
        assert process.stderr == '', process.stderr
        data = json.loads(process.stdout)
        assert data['protocolVersion'] == 1 and data['exitCode'] == code
        assert data['success'] == (code == 0)
        return data

    def candidate(name):
        path = scratch / name
        path.mkdir()
        return path

    def canonical_record(root, collection, ident):
        path = root / 'records' / collection / f'{ident}.yaml'
        path.parent.mkdir(parents=True, exist_ok=True)
        shapes = {
            'rooms': '  presentationSpace:\n    size:\n      width: 1920\n      height: 1080\n',
            'characters': '  profiles: []\n',
        }
        path.write_text(f'id: {ident}\nlabel: {ident}\ndata:\n{shapes[collection]}')
        return path

    def repair(root, *extra, code=0, environment=env):
        return reply('--project', str(root), 'repair', 'project', *extra, code=code,
                     environment=environment)

    # A lone invalid manifest is inspectable, never writable without a second
    # explicit authorization. A random directory has no authorization path.
    empty = candidate('empty')
    assert repair(empty, '--confirm-weak', code=3)['diagnostics'][0]['code'] == \
        'REPAIR_CANDIDATE_NOT_RECOGNIZED'
    assert list(empty.iterdir()) == []
    weak = candidate('weak')
    weak_manifest = weak / 'project.yaml'
    weak_manifest.write_bytes(b'schema: another.thing\nschemaVersion: [invalid\n')
    original_weak = weak_manifest.read_bytes()
    rejected = repair(weak, code=4)
    assert rejected['candidateRecognition'] == 'weak' and rejected['requiresConfirmation']
    assert rejected['diagnostics'][0]['code'] == 'REPAIR_CANDIDATE_CONFIRMATION_REQUIRED'
    assert sorted(p.name for p in weak.iterdir()) == ['project.yaml']
    allowed = reply('repair', 'project', str(weak), '--confirm-weak')
    assert allowed['candidateRecognition'] == 'weak'
    assert allowed['agentKitChanged'] and allowed['agentBootstrapChanged']
    assert weak_manifest.read_bytes() == original_weak
    # Once a real bootstrap is installed it supplies strong recognition.
    assert repair(weak)['candidateRecognition'] == 'strong'
    assert repair(weak, '--confirm-weak')['agentKitChanged'] is False
    assert reply('--project', str(weak), 'agent', 'sync', code=3)['success'] is False
    assert reply('--project', str(weak), 'validate', code=3)['success'] is False
    assert reply('--project', str(weak), 'repair', 'project', '--bogus', code=2)[
        'diagnostics'][0]['code'] == 'CLI_USAGE'
    assert run('repair', 'project', str(weak), '--confirm-weak').stdout.startswith(
        'NovelTea Project Candidate prepared')

    # A syntactically damaged manifest with a recognizable schema can prepare
    # immediately, while ordinary validation remains strict.
    damaged = candidate('damaged')
    manifest = damaged / 'project.yaml'
    manifest.write_bytes(b'schema: noveltea.project.workspace\nschemaVersion: 1\nentrypoint: [bad\n')
    before = manifest.read_bytes()
    first = repair(damaged)
    assert first['candidateRecognition'] == 'strong'
    assert first['candidateEvidence'] == ['project.yaml']
    assert manifest.read_bytes() == before
    assert (damaged / '.noveltea/agent/manifest.json').is_file()
    kit = json.loads((damaged / '.noveltea/agent/manifest.json').read_text())
    assert kit['schema'] == 'noveltea.agent-kit.manifest'
    assert (damaged / '.noveltea/agent/GUIDE.md').is_file()
    assert repair(damaged)['agentKitChanged'] is False

    newer = candidate('newer')
    (newer / 'project.yaml').write_text('schema: noveltea.project.workspace\nschemaVersion: 999\n')
    response = repair(newer)
    assert any(item['code'] == 'REPAIR_NEWER_WORKSPACE_VERSION'
               for item in response['diagnostics'])
    assert (newer / 'project.yaml').read_text().endswith('schemaVersion: 999\n')

    # Independently parsed canonical sources suffice when project.yaml was
    # deleted. Incidental symlinks elsewhere must not block this preparation.
    missing = candidate('missing-manifest')
    room = canonical_record(missing, 'rooms', 'first-room')
    hero = canonical_record(missing, 'characters', 'hero')
    original = {p.relative_to(missing).as_posix(): p.read_bytes() for p in [room, hero]}
    unrelated = scratch / 'outside.txt'
    unrelated.write_text('untouched')
    if os.name != 'nt':
        (missing / 'unrelated-symlink').symlink_to(unrelated)
        (missing / 'records/rooms/external.yaml').symlink_to(unrelated)
    prepared = repair(missing)
    assert prepared['candidateRecognition'] == 'strong'
    assert len(prepared['candidateEvidence']) == 2
    assert all((missing / p).read_bytes() == content for p, content in original.items())
    assert not (missing / 'project.yaml').exists()
    assert unrelated.read_text() == 'untouched'
    assert repair(missing)['agentKitChanged'] is False
    assert reply('repair', 'project', cwd=missing)['projectRoot'] == str(missing)

    # Contextual NovelTea sources provide independent evidence without record
    # placeholders. A single generic/empty file is never sufficient.
    contextual = candidate('context')
    (contextual / 'editor.yaml').write_text(
        'chapters:\n  records: {}\n  assignments: {}\ntags:\n  records: {}\nrecordMetadata: {}\n')
    assert repair(contextual, code=3)['diagnostics'][0]['code'] == \
        'REPAIR_CANDIDATE_NOT_RECOGNIZED'
    (contextual / 'i18n').mkdir()
    (contextual / 'i18n/project.yaml').write_text(
        'sourceLocale: en\ndefaultLocale: en\nlocales:\n  en:\n    supported: true\n')
    assert repair(contextual)['candidateRecognition'] == 'strong'

    # Valid managed markers alone identify the Project Candidate. Bootstrap
    # creation/insertion must leave user text unchanged outside the block.
    marker_only = candidate('markers-only')
    shutil.copy2(missing / 'AGENTS.md', marker_only / 'AGENTS.md')
    assert repair(marker_only)['candidateEvidence'] == ['AGENTS.md']
    instructions = missing / 'AGENTS.md'
    instructions.write_bytes(b'\xef\xbb\xbf# Team\r\n\r\nTeam rules.\r\n')
    repair(missing)
    text = instructions.read_bytes()
    assert text.startswith(b'\xef\xbb\xbf# Team\r\n\r\n')
    assert text.endswith(b'Team rules.\r\n')
    assert b'<!-- DO NOT EDIT THIS BLOCK. -->\r\n' in text
    replacement = text.replace(b'<!-- DO NOT EDIT THIS BLOCK. -->', b'Old instructions')
    instructions.write_bytes(replacement)
    assert repair(missing)['agentBootstrapChanged'] is True
    assert instructions.read_bytes() == text
    assert repair(missing)['agentBootstrapChanged'] is False

    # A malformed or duplicated marker must fail before touching generated
    # outputs, and existing ignore rules are never rewritten.
    old_kit = (missing / '.noveltea/agent/GUIDE.md').read_bytes()
    instructions.write_text('<!-- noveltea:managed-agent-bootstrap:start -->\nunterminated')
    malformed = repair(missing, code=5)
    assert malformed['diagnostics'][0]['code'] == 'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED'
    assert (missing / '.noveltea/agent/GUIDE.md').read_bytes() == old_kit
    instructions.write_bytes(text + text[text.index(b'<!-- noveltea:managed-agent-bootstrap:start -->'):])
    assert repair(missing, code=5)['diagnostics'][0]['code'] == \
        'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED'
    instructions.write_bytes(text)
    custom_ignore = missing / '.gitignore'
    custom_ignore.write_bytes(b'# custom\n/dist/\n')
    warned = repair(missing)
    assert any(x['code'] == 'AGENT_LOCAL_STATE_NOT_IGNORED' for x in warned['diagnostics'])
    assert custom_ignore.read_bytes() == b'# custom\n/dist/\n'

    # All targets must be authenticated before any write. Existing generated
    # kit is rolled back if activation fails after moving the prior version.
    path_cases = ['AGENTS.md', '.gitignore', '.noveltea', '.noveltea/agent']
    for name in path_cases:
        bad = candidate('unsafe-' + name.replace('/', '-').replace('.', 'dot'))
        canonical_record(bad, 'rooms', 'a')
        canonical_record(bad, 'characters', 'b')
        target = bad / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if name == '.noveltea/agent':
            target.parent.mkdir(exist_ok=True)
        if os.name != 'nt':
            target.symlink_to(unrelated)
        else:
            target.mkdir()
        blocked = repair(bad, code=5)
        assert blocked['diagnostics'][0]['code'] == 'REPAIR_PREPARATION_FAILED'
        assert not (bad / '.noveltea/agent/GUIDE.md').exists()
        if name == 'AGENTS.md':
            assert (bad / 'AGENTS.md').is_symlink() if os.name != 'nt' else \
                (bad / 'AGENTS.md').is_dir()

    guide = missing / '.noveltea/agent/GUIDE.md'
    guide.write_bytes(b'tampered')
    before_instructions = instructions.read_bytes()
    rollback = repair(missing, code=5, environment={
        **env, 'NOVELTEA_CLI_CERTIFICATION': '1',
        'NOVELTEA_AGENT_CERTIFY_SWAP_FAILURE': '1'
    })
    assert rollback['diagnostics'][0]['code'] == 'REPAIR_PREPARATION_FAILED'
    assert guide.read_bytes() == b'tampered'
    assert instructions.read_bytes() == before_instructions
    assert not list((missing / '.noveltea').glob('.agent-staging-*'))
    assert not list((missing / '.noveltea').glob('.agent-backup-*'))
    assert repair(missing)['agentKitChanged'] is True
    assert guide.read_bytes() == old_kit

    print('Relocated native candidate repair, evidence, consent, bootstrap, safety and rollback PASSED.')
