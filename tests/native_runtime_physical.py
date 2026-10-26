"""Cold native physical runtime preparation, independent of ScriptC and warm caches."""
import json
import os
import hashlib
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZipFile

binary, root = map(lambda value: Path(value).resolve(), sys.argv[1:3])
pin = root.parents[2] / "build/cli/linux/tools/ffmpeg/bin/ffmpeg"
if "NOVELTEA_FFMPEG" not in os.environ and pin.is_file():
    os.environ["NOVELTEA_FFMPEG"] = str(pin)
executable = os.environ.get("NOVELTEA_FFMPEG")
if not executable or not Path(executable).is_file() or "ffmpeg version 9.0.1" not in subprocess.run(
    [executable, "-version"], capture_output=True, text=True, timeout=10,
).stdout:
    print("SKIP: pinned FFmpeg 9.0.1 media tool unavailable")
    sys.exit(77)


def invoke(args, value=None):
    completed = subprocess.run(
        [str(binary), *args], input=None if value is None else json.dumps(value),
        text=True, capture_output=True, timeout=240,
    )
    assert completed.returncode == 0, completed.stderr[-3000:]
    return json.loads(completed.stdout)


def main():
    prepared = invoke([str(root), "--emit-native-physical"])
    assert prepared["status"] == "prepared", prepared.get("diagnostics", [])[:5]
    artifact = prepared["artifact"]
    assert artifact["gameplayJson"] == json.dumps(
        artifact["compiledProject"], ensure_ascii=False, separators=(",", ":"))
    media = [entry for entry in artifact["packageOptions"]["textEntries"]
             if entry["packagePath"] == "assets/.prepared-media/manifest.json"]
    assert len(media) == 1, "Feature Lab must produce the video-backed Animation manifest"
    manifest = json.loads(media[0]["text"])
    assert manifest["schema"] == "noveltea.private.prepared-media"
    assert len(manifest["motions"]) >= 1
    for motion in manifest["motions"]:
        media_path = motion["browserVideo"]["path"]
        assert any(entry["packagePath"] == media_path and Path(entry["source"]).is_file()
                   for entry in artifact["fileEntries"])
    video_source = (root / "assets/video/opaque-colors.mp4").read_bytes()
    key_data = {"animationId": "opaque-color-loop", "motionId": "colors",
                "canvas": {"width": 96, "height": 64},
                "sourceRange": {"startMs": 500, "endMs": 2500},
                "sampling": {"mode": "source"}, "representationVersion": 5,
                "toolRelease": "ffmpeg-r3"}
    canonical_hash = hashlib.sha256(video_source + b"\0" + json.dumps(
        key_data, separators=(",", ":"), ensure_ascii=False,
    ).encode()).hexdigest()
    assert manifest["motions"][0]["contentHash"] == canonical_hash
    assert "licenses/index.json" in {item["packagePath"]
                                      for item in artifact["packageOptions"]["textEntries"]}
    assert artifact["manifestPreview"]["entryCount"] > len(artifact["fileEntries"])
    assert artifact["manifestPreview"]["assetCount"] == len(artifact["fileEntries"])
    assert artifact["manifestPreview"]["requiredShaderBinaryPaths"] == artifact["requiredShaderBinaryPaths"]
    assert artifact["packageOptions"]["requiredShaderBinaryPaths"] == artifact["requiredShaderBinaryPaths"]
    interfaces = {entry["id"]: entry for entry in
                  artifact["compiledProject"]["resources"]["materialInterfaces"]}
    assert "lab-pattern" in interfaces
    assert "u_tiles" in {entry["name"] for entry in interfaces["lab-pattern"]["parameters"]}

    with TemporaryDirectory() as folder:
        package = Path(folder) / "feature-lab.ntpkg"
        result = invoke(["--write-native-package-stdin"], {
            "project": artifact["compiledProject"],
            "options": artifact["packageOptions"],
            "outputPath": str(package),
        })
        assert result.get("ok") and result.get("success"), result
        with ZipFile(package) as archive:
            paths = set(archive.namelist())
            assert "game" in paths and "licenses/index.json" in paths
            assert "assets/.prepared-media/manifest.json" in paths
            assert json.loads(archive.read("game")) == artifact["compiledProject"]
            decoded = invoke(["--verify-compiled-stdin"], artifact["compiledProject"])
            assert decoded["verified"], decoded.get("diagnostics", [])[:5]
            executed = invoke(["--exercise-compiled-stdin"], json.loads(archive.read("game")))
            assert executed["interactionExecuted"] and executed["dialogueExecuted"]
            for item in manifest["motions"]:
                assert item["browserVideo"]["path"] in paths
            for path in artifact["requiredShaderBinaryPaths"]:
                assert path in paths
            materials = json.loads(archive.read("shader-materials.json"))
            pattern_id = materials["materials"]["lab-pattern"]["shader"]
            patterned = materials["shaders"][pattern_id]
            assert "source" not in patterned["stages"]["fragment"]  # stripped export profile
            assert "u_tiles" in patterned["uniforms"]
            assert patterned["samplers"]["s_pattern"]["stage"] == 1

    admitted = prepared["admitted"]
    with TemporaryDirectory(dir=root) as folder:
        transparent = Path(folder) / "transparent.mov"
        generated = subprocess.run([
            executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", str(root / "assets/video/opaque-colors.mp4"), "-an", "-vf",
            "format=yuva444p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lt(Y,8),if(lt(mod(N,30),15),0,255),if(lt(X,32),0,if(lt(X,64),128,255)))'",
            "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
            "-alpha_bits", "16", "-threads", "2", str(transparent),
        ], capture_output=True, text=True, timeout=120)
        assert generated.returncode == 0, generated.stderr[-2000:]
        alpha_project = json.loads(json.dumps(admitted["project"]))
        source_path = transparent.relative_to(root).as_posix()
        alpha_project["assets"]["opaque-colors"]["data"]["source"]["path"] = source_path
        alpha_revisions = dict(admitted["sourceRevisions"])
        alpha_revisions[source_path] = "sha256:" + hashlib.sha256(transparent.read_bytes()).hexdigest()
        alpha = invoke(["--prepare-native-media-stdin"], {
            "project": alpha_project, "sourceRevisions": alpha_revisions,
            "projectRoot": str(root),
        })
        alpha_manifest = next(item for item in alpha["packageOptions"]["textEntries"]
                              if item["packagePath"] == "assets/.prepared-media/manifest.json")
        alpha_motion = json.loads(alpha_manifest["text"])["motions"][0]
        alpha_path = alpha_motion["alphaWebp"]["path"]
        assert alpha_path.endswith("/alpha.webp")
        alpha_entry = next(item for item in alpha["fileEntries"]
                           if item["packagePath"] == alpha_path)
        alpha_bytes = Path(alpha_entry["source"]).read_bytes()
        assert alpha_bytes[:4] == b"RIFF" and alpha_bytes[8:12] == b"WEBP"
        assert b"ANMF" in alpha_bytes or b"VP8L" in alpha_bytes
        assert sum(item["durationMs"] for item in alpha_motion["frames"]) == 2000

    pure = invoke(["--assemble-admitted-stdin"], {
        "project": admitted["project"],
        "compiledProject": artifact["compiledProject"],
        "referencedAssetIds": admitted["referencedAssetIds"],
        "materialEffectiveInputs": admitted["materialEffectiveInputs"],
        "profile": artifact["profile"], "projectRoot": str(root),
    })
    assert pure["status"] == "prepared", pure.get("diagnostics", [])[:4]
    attempted = {"project": admitted["project"], "artifact": pure["artifact"],
                 "materialEffectiveInputs": admitted["materialEffectiveInputs"],
                 "sourceRevisions": admitted["sourceRevisions"],
                 "projectRoot": str(root), "cancelled": True}
    cancelled = invoke(["--prepare-physical-stdin"], attempted)
    assert cancelled["status"] == "cancelled" and "artifact" not in cancelled
    attempted["cancelled"] = False
    attempted["sourceRevisions"] = dict(attempted["sourceRevisions"])
    asset_source = next(entry["source"] for entry in artifact["fileEntries"]
                        if entry["kind"] in ("image", "audio", "video"))
    relative = Path(asset_source).relative_to(root).as_posix()
    attempted["sourceRevisions"][relative] = "sha256:" + "0" * 64
    drift = invoke(["--prepare-physical-stdin"], attempted)
    assert drift["status"] == "blocked" and "artifact" not in drift
    assert any(item["code"] == "runtime-artifact.physical-source.stale"
               for item in drift["diagnostics"]), drift["diagnostics"][:4]
    attempted["sourceRevisions"] = admitted["sourceRevisions"]
    attempted["artifact"] = json.loads(json.dumps(pure["artifact"]))
    attempted["artifact"]["fileEntries"][0]["source"] = "/etc/passwd"
    unsafe = invoke(["--prepare-physical-stdin"], attempted)
    assert unsafe["status"] == "blocked" and "artifact" not in unsafe
    with TemporaryDirectory(dir=root) as folder:
        notice = Path(folder) / "COPYING.md"
        notice.write_text("Copyright 2026 Example\n", encoding="utf8")
        relative = notice.relative_to(root).as_posix()
        notice_request = {"artifact": pure["artifact"],
                          "project": json.loads(json.dumps(admitted["project"])),
                          "materialEffectiveInputs": admitted["materialEffectiveInputs"],
                          "sourceRevisions": dict(admitted["sourceRevisions"]),
                          "projectRoot": str(root)}
        notice_request["project"]["settings"]["distributionNotices"] = [
            {"path": relative, "displayName": "Native physical certification"},
        ]
        notice_request["sourceRevisions"][relative] = "sha256:" + hashlib.sha256(
            notice.read_bytes()).hexdigest()
        licensed = invoke(["--prepare-physical-stdin"], notice_request)
        assert licensed["status"] == "prepared", licensed.get("diagnostics", [])[:5]
        index = next(item for item in licensed["artifact"]["packageOptions"]["textEntries"]
                     if item["packagePath"] == "licenses/index.json")
        assert json.loads(index["text"])["notices"][0]["displayName"] == "Native physical certification"
        assert any(item["packagePath"] == "licenses/" + relative and "expectedSha256" in item
                   for item in licensed["artifact"]["packageOptions"]["fileEntries"])
        notice.write_text("Mutated notice\n", encoding="utf8")
        stale_notice = invoke(["--prepare-physical-stdin"], notice_request)
        assert stale_notice["status"] == "blocked" and "artifact" not in stale_notice


if __name__ == "__main__":
    main()
