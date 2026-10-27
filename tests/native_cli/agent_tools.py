"""Exercise #546 commands through a relocated standalone executable, without JS."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary, source = map(Path, sys.argv[1:3])
with tempfile.TemporaryDirectory(prefix='noveltea-agent-native-') as temporary:
    root = Path(temporary)
    installed = root / binary.name
    shutil.copy2(binary, installed)
    env = {**os.environ, 'PATH': str(root), 'NOVELTEA_NO_DAEMON': '1'}

    def run(*args, environment=env, cwd=root):
        return subprocess.run([str(installed), *args], cwd=cwd, env=environment,
                              capture_output=True, text=True, timeout=90)

    def json_cli(*args, expected=0, environment=env, cwd=root):
        result = run('--json', *args, environment=environment, cwd=cwd)
        assert result.returncode == expected, (args, result)
        assert result.stderr == '', (args, result.stderr)
        assert len(result.stdout.splitlines()) == 1, (args, result.stdout)
        value = json.loads(result.stdout)
        assert value['success'] == (expected == 0) and value['exitCode'] == expected
        assert value['protocolVersion'] == 1
        return value

    project = root / 'project'
    json_cli('project', 'create', str(project), '--name', 'Standalone Kit')
    first = json_cli('--project', str(project), 'agent', 'sync')
    assert first['agentKitChanged'] is True
    assert first['agentGuidePath'] == str(project / '.noveltea/agent/GUIDE.md')
    agent = project / '.noveltea/agent'
    manifest = json.loads((agent / 'manifest.json').read_text())
    assert manifest['schema'] == 'noveltea.agent-kit.manifest'
    assert manifest['cliVersion'] == (source / 'VERSION').read_text().strip()
    assert manifest['projectWorkspaceVersion'] == 1
    assert 'sources' in manifest['provenance'] and 'documents' in manifest['provenance']
    assert set(manifest['provenance']['documents']) >= {'GUIDE.md', 'technical/LUA.md'}
    files = manifest['files']
    assert len(files) > 40
    assert 'reference' in '/'.join(files) and 'schemas' in '/'.join(files)
    for name, fingerprint in files.items():
        path = agent / name
        assert path.is_file(), name
        assert fingerprint == 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest(), name
    assert (agent / 'GUIDE.md').read_bytes() == (source / 'editor/agent-kit/GUIDE.md').read_bytes()
    assert (agent / 'concepts').is_dir()
    assert (agent / 'system-layouts/manifest.json').is_file()
    layout = json.loads((agent / 'system-layouts/manifest.json').read_text())
    assert layout['roles']['title']['authoringUrl'] == 'system|/ui/title/default-title.rml'
    assert layout['roles']['debug-overlay']['builtinFallback'] is False
    assert layout['baselines']['implicit'] is True
    assert 'agentBootstrapStatus' in first
    again = json_cli('--project', str(project), 'agent', 'sync')
    assert again['agentKitChanged'] is False
    (agent / 'GUIDE.md').write_text('tampered')
    (agent / 'unknown.txt').write_text('unexpected')
    repaired = json_cli('--project', str(project), 'agent', 'sync')
    assert repaired['agentKitChanged'] is True
    assert not (agent / 'unknown.txt').exists()
    assert (agent / 'GUIDE.md').read_bytes() == (source / 'editor/agent-kit/GUIDE.md').read_bytes()

    # --fix owns only the managed marker region, and repeated repair is stable.
    instructions = project / 'AGENTS.md'
    if instructions.exists():
        instructions.unlink()
    no_fix = json_cli('--project', str(project), 'agent', 'sync')
    assert no_fix['agentBootstrapStatus'] == 'missing'
    assert no_fix['diagnostics'][0]['code'] == 'AGENT_BOOTSTRAP_MISSING'
    fixed = json_cli('--project', str(project), 'agent', 'sync', '--fix')
    assert fixed['agentBootstrapStatus'] == 'current'
    assert fixed['agentBootstrapChanged'] is True
    assert instructions.read_text().startswith('# NovelTea Project\n')
    assert json_cli('--project', str(project), 'agent', 'sync', '--fix')[
        'agentBootstrapChanged'] is False
    instructions.write_text('# My title\n\n<!-- noveltea:managed-agent-bootstrap:start -->\nold\n'
                            '<!-- noveltea:managed-agent-bootstrap:end -->\n\ncustom notes\n')
    fixed = json_cli('--project', str(project), 'agent', 'sync', '--fix')
    assert fixed['agentBootstrapChanged'] is True
    assert instructions.read_text().endswith('custom notes\n')
    instructions.write_bytes(b'\xef\xbb\xbf\r\n# Team Project\r\n\r\nTeam rules.\r\n')
    json_cli('--project', str(project), 'agent', 'sync', '--fix')
    repaired_text = instructions.read_bytes()
    assert repaired_text.startswith(b'\xef\xbb\xbf\r\n# Team Project\r\n\r\n')
    assert repaired_text.endswith(b'\r\nTeam rules.\r\n')
    assert b'<!-- DO NOT EDIT THIS BLOCK. -->\r\n' in repaired_text
    if os.name != 'nt' and os.geteuid() != 0:
        # An unwritable directory must not permit an in-place truncation of
        # the otherwise writable user-owned AGENTS.md on an attempted repair.
        original = instructions.read_bytes()
        instructions.write_text(
            '<!-- noveltea:managed-agent-bootstrap:start -->\noutdated\n'
            '<!-- noveltea:managed-agent-bootstrap:end -->\ncustom notes\n')
        expected = instructions.read_bytes()
        project.chmod(0o555)
        try:
            blocked = json_cli('--project', str(project), 'agent', 'sync', '--fix', expected=5)
            assert blocked['diagnostics'][0]['code'] == 'AGENT_SYNC_MUTATION_FAILED'
            assert instructions.read_bytes() == expected
        finally:
            project.chmod(0o755)
        instructions.write_bytes(original)
    instructions.write_text('<!-- noveltea:managed-agent-bootstrap:start -->\nmalformed')
    failure = json_cli('--project', str(project), 'agent', 'sync', '--fix', expected=5)
    assert failure['diagnostics'][0]['code'] == 'AGENT_BOOTSTRAP_MANUAL_REPAIR_REQUIRED'
    assert failure['agentBootstrapStatus'] == 'malformed'
    assert instructions.read_text().endswith('malformed')
    assert json_cli('--project', str(root), 'agent', 'sync', expected=3)[
        'diagnostics'][0]['code'] == 'WORKSPACE_NOT_FOUND'
    assert json_cli('--project', str(project), 'agent', 'sync', '--wrong', expected=2)[
        'diagnostics'][0]['code'] == 'CLI_USAGE'
    print('Relocated native Agent Kit, manifests, hashes, idempotency, bootstrap passed.')

    # Projectless commands must not call into JS or require Project discovery.
    for command in ['status', 'stop']:
        reply = json_cli('daemon', command)
        assert isinstance(reply['daemon']['running'], bool)
        assert reply['daemon']['protocol'] == 1
        assert reply['daemon']['state'] in ('stopped', 'starting', 'running', 'draining', 'ready')
    assert json_cli('--project', str(project), 'daemon', 'status', expected=2)[
        'diagnostics'][0]['code'] == 'CLI_USAGE'
    assert json_cli('daemon', 'bogus', expected=2)['diagnostics'][0]['code'] == 'CLI_USAGE'
    assert json_cli('media-tool', 'check', '--extra', expected=2)[
        'diagnostics'][0]['code'] == 'CLI_USAGE'
    assert json_cli('media-tool', 'check', expected=6)['diagnostics'][0]['code'] == 'media.tool'
    assert json_cli('media-tool', 'check', expected=6, environment={
        **env, 'NOVELTEA_FFMPEG': 'relative/path'
    })['diagnostics'][0]['message'].startswith('NOVELTEA_FFMPEG must name an absolute')
    for name in ['shaderc', 'texturec']:
        raw = run(name, '--help')
        assert raw.returncode == 1 and raw.stderr == '', (name, raw)
        assert f'Usage: {name}' in raw.stdout
    if os.name != 'nt':
        mock = root / 'ffmpeg'
        mock.write_text('#!/bin/sh\ncase "$1" in\n-version) echo "ffmpeg version 15.1 test" ;;\n'
                        '-hide_banner) case "$2" in\n'
                        '-encoders) printf "libaom-av1 libvpx-vp9\\n" ;;\n'
                        '-protocols) printf "file pipe\\n" ;;\nesac ;;\nesac\n')
        mock.chmod(0o755)
        good = json_cli('media-tool', 'check', environment={
            **env, 'NOVELTEA_FFMPEG': str(mock)
        })
        assert good['tool'] == {
            'bundled': False, 'executable': str(mock), 'release': None, 'version': '15.1'
        }
        assert run('media-tool', 'check', environment={
            **env, 'NOVELTEA_FFMPEG': str(mock)
        }).stdout == f'FFmpeg 15.1: {mock}\n'
        mock.write_text('#!/bin/sh\necho "ffmpeg version 15.1 test"\n')
        mock.chmod(0o755)
        assert 'missing encoder' in json_cli('media-tool', 'check', expected=6, environment={
            **env, 'NOVELTEA_FFMPEG': str(mock)
        })['diagnostics'][0]['message']
        # The default path comes from the relocated executable, not cwd or source checkout.
        bundled = root / 'tools/ffmpeg/bin/ffmpeg'
        bundled.parent.mkdir(parents=True)
        bundled.write_text(
            '#!/bin/sh\ncase "$1" in\n'
            '-version) printf "ffmpeg version 9.0.1\\n'
            '--disable-gpl --disable-nonfree --disable-version3 --disable-network\\n'
            '--enable-libaom --enable-libvpx --enable-libwebp --enable-libzimg\\n" ;;\n'
            '-hide_banner) case "$2" in\n'
            '-encoders) printf "libaom-av1 libvpx-vp9 libwebp_anim\\n" ;;\n'
            '-protocols) printf "file pipe\\n" ;;\nesac ;;\nesac\n'
        )
        bundled.chmod(0o755)
        tool = json_cli('media-tool', 'check')['tool']
        assert tool == {
            'bundled': True, 'executable': str(bundled),
            'release': 'ffmpeg-r3', 'version': '9.0.1'
        }
    print('Relocated native daemon and FFmpeg projectless contracts passed.')
