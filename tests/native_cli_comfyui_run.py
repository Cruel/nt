#!/usr/bin/env python3
"""Installed native ComfyUI run contract: remote execution, publication and failure."""

import json
import os
import signal
import struct
import subprocess
import sys
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from urllib.parse import urlparse

cli = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()
manifests = [json.loads(p.read_text()) for p in
             (repo / "editor/assets/comfyui/workflows").glob("*.manifest.json")]
node_inputs = {}
for definition in manifests:
    for bindings in definition["bindings"].values():
        for binding in bindings:
            node_inputs.setdefault(binding["classType"], set()).add(binding["inputName"])
    for name in definition["requiredNodeClasses"]:
        node_inputs.setdefault(name, set())


def png():
    def chunk(name, content):
        return struct.pack(">I", len(content)) + name + content + struct.pack(
            ">I", zlib.crc32(name + content))
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(b"\0\xff\0\0\xff")) +
            chunk(b"IEND", b""))


class Handler(BaseHTTPRequestHandler):
    uploaded = False
    submitted = Event()
    deleted = []
    mode = "normal"
    on_history = None
    last_prompt = None
    last_graph = None

    def log_message(self, *_):
        pass

    def send(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if self.path == "/upload/image":
            assert b'Content-Disposition: form-data; name="image"' in body
            self.__class__.uploaded = True
            import re
            match = re.search(rb'filename="([^"]+)"', body)
            self.send({"name": match.group(1).decode(), "subfolder": "", "type": "input"})
        elif self.path == "/prompt":
            request = json.loads(body)
            assert request["prompt"] and request["client_id"]
            self.__class__.last_prompt = request["prompt_id"]
            self.__class__.last_graph = request["prompt"]
            self.__class__.submitted.set()
            self.send({"prompt_id": request["prompt_id"]})
        elif self.path == "/queue":
            self.__class__.deleted.extend(json.loads(body)["delete"])
            self.send({})
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == "/object_info":
            return self.send({name: {"input": {"required": {
                key: ["STRING"] for key in fields}}}
                for name, fields in node_inputs.items()})
        if self.path.startswith("/history/"):
            prompt = self.path.split("/")[-1]
            if self.__class__.on_history:
                callback = self.__class__.on_history
                self.__class__.on_history = None
                callback()
            if self.__class__.mode == "waiting":
                return self.send({})
            if self.__class__.mode == "error":
                return self.send({prompt: {"status": {"status_str": "error"}}})
            graph = self.__class__.last_graph
            outputs = {
                id: {"images": [{"filename": "test.png", "subfolder":
                                 42 if self.__class__.mode == "malformed_descriptor" else "",
                                 "type": "output"}]}
                for id, node in graph.items() if node.get("class_type") == "SaveImage"
            }
            return self.send({prompt: {"status": {"completed": True}, "outputs": outputs}})
        if urlparse(self.path).path == "/view":
            body = png() if self.__class__.mode != "corrupt" else b"not an image"
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)
        self.send_error(404)


with TemporaryDirectory(prefix="noveltea-comfyui-run-") as temporary:
    root = Path(temporary)
    home = root / "home"
    home.mkdir()
    env = dict(os.environ, NOVELTEA_USER_CONFIG_ROOT=str(home))
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{server.server_port}"
    config = {
        "format": "noveltea.user-config", "formatVersion": 1,
        "preferences": {},
        "comfyui": {
            "serverUrl": url, "requestTimeoutMs": 4000,
            "defaultWorkflows": {"image.generate": "flux2-klein-text-to-image"},
        },
    }
    (home / "config.json").write_text(json.dumps(config))

    def cmd(*args, status=0):
        command = [str(cli), "--no-daemon", "--json", *map(str, args)]
        process = subprocess.run(command, cwd=root, env=env, capture_output=True,
                                 text=True, timeout=30)
        assert process.returncode == status, (command, process.stdout, process.stderr)
        assert process.stderr == "", process.stderr
        result = json.loads(process.stdout)
        assert result["exitCode"] == status, result
        return result

    try:
        output = root / "output"
        output.mkdir()
        base = ("comfyui", "run", "--type", "image.generate", "--input", "prompt=hello")
        without_route = cmd(*base, status=4)
        assert without_route["diagnostics"][0]["code"] == "COMFYUI_OUTPUT_ROUTE_REQUIRED"
        assert not Handler.submitted.is_set()
        executed = cmd(*base, "--output", output)
        assert executed["outputs"]["images"][0]["target"] == "filesystem", executed
        assert len(list(output.glob("*.png"))) == 1
        assert list(output.glob("*.png"))[0].read_bytes() == png()
        assert not list(output.glob("*.noveltea-stage"))

        Handler.mode = "corrupt"
        invalid = cmd(*base, "--output", output, status=4)
        assert invalid["diagnostics"][0]["code"] == "COMFYUI_OUTPUT_INVALID", invalid
        assert len(list(output.glob("*.png"))) == 1
        Handler.mode = "error"
        failed = cmd(*base, "--output", output, status=4)
        assert failed["diagnostics"][0]["code"] == "COMFYUI_EXECUTION_FAILED", failed
        Handler.mode = "malformed_descriptor"
        bad_descriptor = cmd(*base, "--output", output, status=4)
        assert bad_descriptor["diagnostics"][0]["code"] == "COMFYUI_OUTPUT_INVALID", bad_descriptor
        Handler.mode = "normal"

        project = root / "project"
        cmd("project", "create", project, "--name", "ComfyUI Native Run")
        generated = cmd("--project", project, "comfyui", "run",
                        "flux2-klein-text-to-image", "--input", "prompt=hello")
        asset = generated["outputs"]["images"][0]
        assert asset["target"] == "asset" and asset["assetId"], generated
        assert (project / asset["projectRelativePath"]).read_bytes() == png()
        assert (project / "records/assets" / f"{asset['assetId']}.yaml").exists()

        original_records = sorted((project / "records/assets").glob("*.yaml"))
        Handler.on_history = lambda: (project / "project.yaml").write_text(
            (project / "project.yaml").read_text() + "\n# concurrent source edit\n")
        conflict = cmd("--project", project, "comfyui", "run",
                       "flux2-klein-text-to-image", "--input", "prompt=stale",
                       status=4)
        assert conflict["diagnostics"][0]["code"] == "COMFYUI_ASSET_PUBLICATION_CONFLICT", conflict
        assert sorted((project / "records/assets").glob("*.yaml")) == original_records

        edited = root / "source.png"
        edited.write_bytes(png())
        edited_output = root / "edited"
        edited_output.mkdir()
        image_run = cmd("comfyui", "run", "flux2-klein-image-edit",
                        "--input", "prompt=edit", "--input", f"sourceImage={edited}",
                        "--output", edited_output)
        assert image_run["success"] and Handler.uploaded, image_run

        Handler.mode = "waiting"
        Handler.submitted.clear()
        command = [str(cli), "--no-daemon", "--json", *base, "--output", str(output)]
        process = subprocess.Popen(command, cwd=root, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert Handler.submitted.wait(10), "Native CLI did not submit the cancelable prompt."
        # Wait until the response to /prompt has been received and the CLI is
        # polling history, not while the submission socket is completing.
        time.sleep(0.2)
        process.send_signal(signal.SIGINT)
        stdout, stderr = process.communicate(timeout=10)
        interrupted = json.loads(stdout)
        assert process.returncode == 130 and interrupted["exitCode"] == 130, (stdout, stderr)
        assert Handler.last_prompt in Handler.deleted, Handler.deleted
        assert stderr == "" and not list(output.glob("*.noveltea-stage"))
        Handler.mode = "normal"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

print("Native ComfyUI run, input upload, projectless files, Assets, errors and cancellation passed.")
