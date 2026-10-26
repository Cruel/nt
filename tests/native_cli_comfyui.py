#!/usr/bin/env python3
"""Installed native ComfyUI catalog/status/verify contract; no ScriptC or editor runtime."""

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


cli, repo = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
source = repo / "editor/assets/comfyui/workflows"
manifest_files = sorted(source.glob("*.manifest.json"))
manifests = [json.loads(p.read_text()) for p in manifest_files]
node_inputs = {}
for definition in manifests:
    for public_input, bindings in definition["bindings"].items():
        for binding in bindings:
            node_inputs.setdefault(binding["classType"], set()).add(binding["inputName"])
    for class_name in definition["requiredNodeClasses"]:
        node_inputs.setdefault(class_name, set())


class Handler(BaseHTTPRequestHandler):
    status_code = 200
    missing_classes = False
    requests = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.requests.append(self.path)
        if self.path.endswith("/system_stats"):
            body = {"system": {"comfyui_version": "fake-2.0"}}
        elif self.path.endswith("/queue"):
            body = {"queue_running": [1], "queue_pending": [2, 3]}
        elif self.path.endswith("/object_info"):
            body = {
                name: {"input": {"required": {field: ["STRING"] for field in fields}}}
                for name, fields in node_inputs.items()
                if not self.missing_classes or name != "SaveImage"
            }
        else:
            self.send_error(404)
            return
        payload = json.dumps(body).encode("utf8")
        self.send_response(self.status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


with TemporaryDirectory(prefix="noveltea-native-comfyui-") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    env = dict(os.environ, NOVELTEA_USER_CONFIG_ROOT=str(home))

    def run(args, *, json_mode=True, exit_code=0, cwd=root):
        command = [str(cli), "--no-daemon"]
        if json_mode:
            command += ["--json"]
        command += args
        value = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=20)
        assert value.returncode == exit_code, (command, value.returncode, value.stdout, value.stderr)
        if not json_mode:
            return value
        assert value.stderr == "", (command, value.stderr)
        obj = json.loads(value.stdout)
        assert obj["protocolVersion"] == 1 and obj["exitCode"] == exit_code, obj
        assert obj["success"] is (exit_code == 0), obj
        return obj

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    try:
        # Embedded workflows are independent of cwd and source-tree files.
        workflows = run(["comfyui", "workflows"])["workflows"]
        assert len(workflows) == len(manifests), workflows
        assert [w["id"] for w in workflows] == sorted(w["id"] for w in workflows)
        for workflow in workflows:
            assert workflow["source"] == "built-in" and workflow["validationStatus"] == "valid", workflow
            assert workflow["packageHash"].startswith("sha256:"), workflow
            inspected = run(["comfyui", "workflows", workflow["id"]])["workflow"]
            assert inspected["provider"] == "comfyui" and inspected["inputs"] and inspected["outputs"]
        assert "Inputs:" in run(["comfyui", "workflows", workflows[0]["id"]], json_mode=False).stdout

        status = run(["comfyui", "status", "--server", url])
        assert status["comfyUiVersion"] == "fake-2.0" and status["queueRemaining"] == 3, status
        assert "ComfyUI ready" in run(["comfyui", "status", "--server", url], json_mode=False).stdout
        assert "/system_stats" in Handler.requests and "/queue" in Handler.requests
        # Absolute ComfyUI API routes are resolved against the origin.
        with_path = run(["comfyui", "status", "--server", url + "/nested/base"])
        assert with_path["serverUrl"].endswith("/nested/base")
        assert Handler.requests[-2:] == ["/system_stats", "/queue"], Handler.requests

        verification = run(["comfyui", "verify", workflows[0]["id"], "--server", url])
        assert len(verification["verified"]) == 1 and not verification["failed"], verification
        assert verification["verified"][0]["workflowKey"].startswith("built-in:"), verification
        cache = json.loads((home / "comfyui/verification-cache.json").read_text())
        assert cache["schema"] == "noveltea.comfyui-workflow-verification-cache"
        refreshed = run(["comfyui", "workflows", workflows[0]["id"]])["workflow"]
        assert refreshed["verification"]["status"] == "unverified"  # default config points elsewhere
        full = run(["comfyui", "verify", "--server", url])
        assert len(full["verified"]) == len(workflows), full

        Handler.missing_classes = True
        failed = run(["comfyui", "verify", "--server", url], exit_code=4)
        assert failed["failed"] and any(d["code"] == "COMFYUI_VERIFICATION_FAILED" for d in failed["diagnostics"])
        Handler.missing_classes = False
        Handler.status_code = 503
        down = run(["comfyui", "status", "--server", url], exit_code=4)
        assert down["diagnostics"][0]["code"] == "COMFYUI_SERVER_UNAVAILABLE", down
        assert down["serverUrl"] == url
        Handler.status_code = 200
        refused = run(["comfyui", "status", "--server", "http://127.0.0.1:1"], exit_code=4)
        assert refused["diagnostics"][0]["code"] == "COMFYUI_SERVER_UNAVAILABLE"

        for args in [
            ["comfyui", "status", "--server", "file:///etc/passwd"],
            ["comfyui", "status", "--server"],
            ["comfyui", "status", "--server", url, "--server", url],
            ["comfyui", "workflows", "--all", "--all"],
            ["comfyui", "workflows", "missing", "--all"],
            ["comfyui", "verify", "--garbage"],
        ]:
            invalid = run(args, exit_code=2)
            assert invalid["diagnostics"][0]["code"] == "CLI_USAGE", invalid
        assert run(["--project", str(root), "comfyui", "status"], exit_code=2)["exitCode"] == 2
        assert run(["comfyui", "verify", "missing", "--server", url], exit_code=4)["diagnostics"][0]["path"] == "/workflowId"

        # Shared config and user catalog are selected without an editor/JS runtime.
        (home / "config.json").write_text(json.dumps({
            "format": "noveltea.user-config", "formatVersion": 1, "preferences": {},
            "comfyui": {"serverUrl": url, "requestTimeoutMs": 15000, "defaultWorkflows": {}},
        }))
        assert run(["comfyui", "status"])["serverUrl"] == url
        copied = dict(manifests[0], label="User workflow override")
        user_workflows = home / "comfyui/workflows"
        user_workflows.mkdir()
        (user_workflows / manifest_files[0].name).write_text(json.dumps(copied))
        (user_workflows / copied["workflowFile"]).write_bytes((source / copied["workflowFile"]).read_bytes())
        selected = run(["comfyui", "workflows", copied["id"]])["workflow"]
        assert selected["source"] == "user" and selected["label"] == "User workflow override", selected
        all_workflows = run(["comfyui", "workflows", "--all"])["workflows"]
        assert any(w["overridden"] and w["source"] == "built-in" for w in all_workflows)
        (user_workflows / "bad.manifest.json").write_text('{"schemaVersion":2,"id":"bad"}')
        (user_workflows / "future.manifest.json").write_text(json.dumps({
            **manifests[0], "id": "not-current", "futureField": True,
        }))
        (user_workflows / "extra-graph.manifest.json").write_text(json.dumps({
            **manifests[0], "id": "badcontract", "contract": {
                **manifests[0]["contract"], "inputs": {
                    **manifests[0]["contract"]["inputs"],
                    "extraneous": {"type": "string", "required": False},
                },
            },
        }))
        all_workflows = run(["comfyui", "workflows", "--all"])
        assert any(w["manifestFile"] == "bad.manifest.json" and w["validationStatus"] == "invalid" for w in all_workflows["workflows"])
        assert all(
            any(w["manifestFile"] == filename and w["validationStatus"] == "invalid"
                for w in all_workflows["workflows"])
            for filename in ("future.manifest.json", "extra-graph.manifest.json")
        ), all_workflows
        assert any(d["code"] == "COMFYUI_WORKFLOW_INVALID" for d in all_workflows["diagnostics"])
        assert run(["comfyui", "workflows", "bad"], exit_code=4)["diagnostics"][0]["code"] == "COMFYUI_WORKFLOW_NOT_FOUND"

        # A real Project is admitted by the existing native Project engine, then wins precedence.
        project = root / "project"
        run(["project", "create", str(project), "--name", "ComfyUI Native Fixture"])
        project_workflows = project / "workflows"
        project_workflows.mkdir(exist_ok=True)
        project_manifest = dict(manifests[0], label="Project workflow override")
        (project_workflows / manifest_files[0].name).write_text(json.dumps(project_manifest))
        (project_workflows / project_manifest["workflowFile"]).write_bytes(
            (source / project_manifest["workflowFile"]).read_bytes()
        )
        project_args = ["--project", str(project), "comfyui"]
        selected = run([*project_args, "workflows", project_manifest["id"]])["workflow"]
        assert selected["source"] == "project" and selected["label"] == "Project workflow override"
        assert selected["workflowKey"].startswith("project:")
        assert run([*project_args, "verify", project_manifest["id"], "--server", url])["verified"]
        assert any(w["overridden"] and w["source"] == "user"
                   for w in run([*project_args, "workflows", "--all"])["workflows"])

        # Explicit Project admission is preserved (no fabricated Project authority).
        missing = run(["--project", str(root / "missing"), "comfyui", "workflows"], exit_code=3)
        assert missing["diagnostics"][0]["code"] == "WORKSPACE_NOT_FOUND", missing
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print("Native ComfyUI catalog, status, verification, cache, overrides and negatives passed.")
