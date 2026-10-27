"""Native cold artifact vs independently executed TypeScript preparation.

Source authority is admitted by the native C++ Project owner before either
lowerer runs; no warmed runtime artifact is read or passed between processes.
"""
import json
from copy import deepcopy
import os
from pathlib import Path
import subprocess
import sys

binary, source = map(lambda p: Path(p).resolve(), sys.argv[1:3])
reference = source / "editor/scripts/native-runtime-artifact-parity-reference.mjs"


def invoke(command, input_text=None, cwd=None):
    process = subprocess.run(command, input=input_text, text=True,
                             capture_output=True, cwd=cwd, timeout=240)
    if process.returncode:
        raise AssertionError(f"{command} failed: {process.stderr[-3500:]}")
    return json.loads(process.stdout)


def difference(expected, actual, path=""):
    if type(expected) is not type(actual):
        return path, expected, actual
    if isinstance(expected, dict):
        for key in sorted(expected.keys() | actual.keys()):
            if key not in expected or key not in actual:
                return f"{path}/{key}", expected.get(key, "<absent>"), actual.get(key, "<absent>")
            found = difference(expected[key], actual[key], f"{path}/{key}")
            if found:
                return found
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            return f"{path}/length", len(expected), len(actual)
        for index, (left, right) in enumerate(zip(expected, actual)):
            found = difference(left, right, f"{path}/{index}")
            if found:
                return found
    elif expected != actual:
        return path, expected, actual
    return None


def assert_artifact_matches(name, reference_result, native_result):
    assert reference_result["status"] == "prepared", (name, reference_result.get("diagnostics", [])[:5])
    assert native_result["status"] == "prepared", (name, native_result.get("diagnostics", [])[:5])
    assert reference_result["schemaValid"] and reference_result["nativeSchemaValid"], (
        name, "Prepared artifact fails canonical schema")
    for component in ("profile", "sourceFingerprint", "compiledProject", "gameplayJson", "fileEntries",
                      "manifestPreview", "packageOptions", "localization", "diagnostics"):
        mismatch = difference(reference_result["artifact"][component], native_result["artifact"][component],
                              "/" + component)
        if mismatch:
            path, left, right = mismatch
            raise AssertionError(f"{name}: {path}: ref={str(left)[:250]!r} "
                                 f"native={str(right)[:250]!r}")


def main():
    for name, fixture in (("feature-lab", source / "tests/projects/feature-lab"),):
        native = invoke([str(binary), str(fixture), "--emit-native-prepared"])
        assert native["status"] == "prepared", (name, native.get("diagnostics", [])[:5])
        compiled = invoke([str(binary), "--compile-admitted-stdin"], json.dumps(native["project"]))
        assert "localization" in compiled, "Native compiled input is invalid"
        expected = invoke(["node", str(reference)], json.dumps({
            "project": native["project"],
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "nativeArtifact": native["artifact"],
        }), source / "editor")
        if os.environ.get("NOVELTEA_ARTIFACT_INSPECT"):
            Path("/tmp/nt558-native.json").write_text(json.dumps(native, ensure_ascii=False))
            Path("/tmp/nt558-reference.json").write_text(json.dumps(expected, ensure_ascii=False))
        assert_artifact_matches(name, expected, native)
        assert native["artifact"]["gameplayJson"] == json.dumps(
            native["artifact"]["compiledProject"], separators=(",", ":"), ensure_ascii=False)
        physical = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": native["project"], "compiledProject": compiled,
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": native["artifact"]["profile"], "projectRoot": str(fixture),
        }))
        assert physical["status"] == "prepared", physical.get("diagnostics", [])[:4]
        assert physical["artifact"]["fileEntries"], "Missing physical file entries"
        for entry in physical["artifact"]["fileEntries"]:
            assert Path(entry["source"]).is_relative_to(fixture), entry
        assert physical["artifact"]["sourceFingerprint"] == native["artifact"]["sourceFingerprint"]
        decoded = invoke([str(binary), "--verify-compiled-stdin"],
                         native["artifact"]["gameplayJson"])
        assert decoded["verified"], "Prepared gameplay JSON fails native runtime codec"
        exercised = invoke([str(binary), "--exercise-compiled-stdin"],
                           native["artifact"]["gameplayJson"])
        assert exercised["dialogueExecuted"] and exercised["interactionExecuted"], (
            "Prepared gameplay JSON does not execute in the native engine")
        alternate_profile = {**native["artifact"]["profile"],
                             "excludeUnusedAssets": False, "stripShaderSources": False,
                             "localization": {"locales": ["fr", "fr-CA", "en"],
                                              "defaultLocale": "fr", "quality": "reviewed-release"}}
        alternate = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": native["project"], "compiledProject": compiled,
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": alternate_profile,
        }))
        assert alternate["status"] == "prepared", alternate.get("diagnostics", [])[:5]
        alternate_reference = invoke(["node", str(reference)], json.dumps({
            "project": native["project"], "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": alternate_profile, "nativeArtifact": alternate["artifact"],
        }), source / "editor")
        if os.environ.get("NOVELTEA_ARTIFACT_INSPECT"):
            Path("/tmp/nt558-compiled.json").write_text(json.dumps(compiled, ensure_ascii=False))
            Path("/tmp/nt558-alternate.json").write_text(json.dumps(alternate, ensure_ascii=False))
            Path("/tmp/nt558-alternate-reference.json").write_text(json.dumps(alternate_reference, ensure_ascii=False))
        assert_artifact_matches(name + " alternate", alternate_reference, alternate)

        # Quality diagnostics must not silently omit stale but otherwise valid
        # authored translations or localized Asset variants.
        stale_project = deepcopy(native["project"])
        stale_project["localization"]["translations"]["fr"]["25700000-0000-4000-8000-000000000001"][
            "sourceFingerprint"] = "fnv1a:" + "0" * 32
        stale_project["localization"]["translations"]["fr"]["f0b75a61-85b2-53fd-9d5f-5b43eb6bb8f1"][
            "sourceFingerprint"] = "fnv1a:" + "0" * 32
        stale_project["localization"]["assets"]["fr"]["ui-pattern"]["sourceFingerprint"] = (
            "fnv1a:" + "0" * 32)
        stale_compiled = invoke([str(binary), "--compile-admitted-stdin"], json.dumps(stale_project))
        stale = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": stale_project, "compiledProject": stale_compiled,
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": alternate_profile,
        }))
        stale_reference = invoke(["node", str(reference)], json.dumps({
            "project": stale_project, "referencedAssetIds": native["referencedAssetIds"],
            "profile": alternate_profile, "nativeArtifact": stale.get("artifact"),
        }), source / "editor")
        assert_artifact_matches(name + " stale", stale_reference, stale)
        warning_codes = [item["code"] for item in stale["artifact"]["diagnostics"]]
        assert "localization.export.message_outdated" in warning_codes, warning_codes[-4:]
        assert any(item["code"] == "localization.export.message_outdated" and
                   item["path"].endswith("/f0b75a61-85b2-53fd-9d5f-5b43eb6bb8f1")
                   for item in stale["artifact"]["diagnostics"])
        assert "localization.export.asset_outdated" in warning_codes, warning_codes[-4:]

        blocked = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": native["project"],
            "compiledProject": compiled,
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": {**native["artifact"]["profile"], "localization": {
                "locales": ["unknown"], "defaultLocale": "unknown", "quality": "release"}},
        }))
        assert blocked["status"] == "blocked" and "artifact" not in blocked
        assert any(d["code"] == "localization.export.locale_not_supported" for d in blocked["diagnostics"])
        malformed = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": native["project"], "compiledProject": {},
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": native["artifact"]["profile"],
        }))
        assert malformed["status"] == "blocked" and "artifact" not in malformed
        assert any(d["code"] == "runtime-artifact.compiled.invalid" for d in malformed["diagnostics"])
        no_entrypoint = deepcopy(native["project"])
        no_entrypoint["entrypoint"] = None
        entrypoint_block = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": no_entrypoint, "compiledProject": compiled,
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": native["artifact"]["profile"],
        }))
        assert entrypoint_block["status"] == "blocked" and "artifact" not in entrypoint_block
        assert any(d["code"] == "runtime-package.entrypoint.required"
                   for d in entrypoint_block["diagnostics"])

        # Inputs are never permitted to smuggle an external physical package
        # source through an otherwise valid compiled authoring wire.
        traversal_project = deepcopy(native["project"])
        traversal_project["scripts"][next(iter(traversal_project["scripts"]))]["data"][
            "source"] = {"kind": "project-file", "path": "../outside.lua"}
        unsafe = invoke([str(binary), "--assemble-admitted-stdin"], json.dumps({
            "project": traversal_project, "compiledProject": compiled,
            "referencedAssetIds": native["referencedAssetIds"],
            "materialEffectiveInputs": native["materialEffectiveInputs"],
            "profile": native["artifact"]["profile"], "projectRoot": "/tmp/project",
        }))
        assert unsafe["status"] == "blocked" and "artifact" not in unsafe
        assert any(d["code"] == "runtime-artifact.preparation.invalid" for d in unsafe["diagnostics"])


if __name__ == "__main__":
    main()
