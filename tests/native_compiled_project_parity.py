"""Cold C++/TypeScript differential certification for #552 (not a production compiler).

An authoritative C++ Project reader admits every case. A separately run TS
reference compiles only those admitted JSON generations; neither process reads
cached compiled runtime artifacts. Missing gameplay families are reported, never
silently counted as passing parity.
"""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


binary, source = map(lambda s: Path(s).resolve(), sys.argv[1:3])
fixture = source / "tests/projects/feature-lab"
reference = source / "editor/scripts/native-compiled-parity-reference.mjs"


def invoke(*command, stdin=None):
    result = subprocess.run(command, text=True, input=stdin, capture_output=True,
                            timeout=180, check=False)
    if result.returncode != 0:
        raise AssertionError(f"{' '.join(map(str, command))} exited {result.returncode}:\n"
                             f"{result.stderr}\n{result.stdout[:3000]}")
    return json.loads(result.stdout)


def difference(expected, actual, path=""):
    """First deterministic JSON pointer difference, including array ordering."""
    if type(expected) is not type(actual):
        return path or "/", expected, actual
    if isinstance(expected, dict):
        for key in sorted(expected.keys() | actual.keys()):
            pointer = path + "/" + key.replace("~", "~0").replace("/", "~1")
            if key not in expected or key not in actual:
                return pointer, expected.get(key, "<absent>"), actual.get(key, "<absent>")
            mismatch = difference(expected[key], actual[key], pointer)
            if mismatch:
                return mismatch
    elif isinstance(expected, list):
        if len(expected) != len(actual):
            return path + "/length", len(expected), len(actual)
        for index, (left, right) in enumerate(zip(expected, actual)):
            mismatch = difference(left, right, f"{path}/{index}")
            if mismatch:
                return mismatch
    elif expected != actual:
        return path or "/", expected, actual
    return None


def compare(case, family, expected, actual):
    mismatch = difference(expected, actual, "/" + family.replace(".", "/"))
    if mismatch:
        pointer, left, right = mismatch
        raise AssertionError(f"{case}: {family} mismatch at {pointer}: "
                             f"reference={str(left)[:350]!r}, native={str(right)[:350]!r}")


def copy_project(destination):
    shutil.copytree(fixture, destination,
                    ignore=shutil.ignore_patterns(".noveltea", "node_modules"),
                    symlinks=True)
    assert not (destination / ".noveltea/cache/runtime").exists()


def create_small(destination, with_entrypoint=True):
    assert invoke(binary, destination, "--create-small")["created"]
    if with_entrypoint:
        with (destination / "project.yaml").open("a", encoding="utf-8") as output:
            output.write("\nentrypoint:\n  kind: room\n  id: starting-room\n")


def edit(path, before, after):
    text = path.read_text(encoding="utf-8")
    assert before in text, f"Missing fixture edit anchor in {path}"
    path.write_text(text.replace(before, after, 1), encoding="utf-8")


def main():
    with tempfile.TemporaryDirectory(prefix="noveltea-compiled-parity-") as temporary:
        root = Path(temporary)
        cases = {}
        for name in ("feature-lab", "unicode-label", "ordering", "missing-entrypoint",
                     "invalid-asset"):
            target = root / name
            if name == "feature-lab":
                copy_project(target)
            else:
                create_small(target, with_entrypoint=name != "missing-entrypoint")
            if name == "unicode-label":
                variable = target / "records/variables/alpha.yaml"
                edit(variable, "label: Variable alpha", 'label: "Unicode ☕ 漢字 😀"')
            if name == "ordering":
                # Creation order is zeta then alpha; compilation sorts by id.
                assert (target / "records/variables/zeta.yaml").is_file()
                assert (target / "records/variables/alpha.yaml").is_file()
            if name == "invalid-asset":
                asset = target / "records/assets/ui-pattern.yaml"
                asset.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(fixture / "records/assets/ui-pattern.yaml", asset)
                edit(asset, "kind: image", "kind: invalid-kind")

            admitted = invoke(binary, str(target), "--emit-parity")
            cases[name] = admitted
            assert not (target / ".noveltea/cache/runtime").exists(), (
                f"{name}: cold parity may not create or consume runtime cache")

        admitted_cases = [{"name": name, "project": data["project"]}
                          for name, data in cases.items() if "project" in data]
        assert {entry["name"] for entry in admitted_cases} >= {"feature-lab", "unicode-label",
                                                                  "ordering", "missing-entrypoint"}, cases
        reference_results = invoke("node", reference,
                                   stdin=json.dumps({"cases": admitted_cases}, ensure_ascii=False))
        references = {value["name"]: value for value in reference_results["results"]}
        checked = 0
        for name, data in cases.items():
            if not data["ok"]:
                assert name in {"missing-entrypoint", "invalid-asset"}, (name, data)
                assert data["diagnostics"], (name, data)
                if name == "missing-entrypoint":
                    assert not references[name]["ok"], name
                    reference_diagnostics = [
                        {"code": item["code"], "severity": item["severity"],
                         "path": item["jsonPointer"], "message": item["message"]}
                        for item in references[name]["diagnostics"]]
                    compare(name, "diagnostics.entrypoint", reference_diagnostics,
                            data["diagnostics"])
                else:
                    assert any(diagnostic.get("code") == "schema.enum" and
                               diagnostic.get("path") == "/assets/ui-pattern/data/kind"
                               for diagnostic in data["diagnostics"]), data["diagnostics"]
                print(f"{name}: native admission/lowering rejected with {data['diagnostics'][0]}")
                continue
            assert data["sourceGeneration"] and data["sourceRevisions"], name
            assert "project.yaml" in data["sourceRevisions"], name
            if name == "feature-lab":
                assert any(path.startswith("assets/") for path in data["sourceRevisions"]), (
                    "Native source proof lost physical Asset authority")
                assert data["referencedAssetIds"], (
                    "Native source proof lost external Asset reference closure")
            expected = references[name]
            assert expected["ok"], (name, expected["diagnostics"])
            wire, partial = expected["project"], data["native"]
            for family in ("project", "bootstrapModule", "entrypoint"):
                compare(name, family, wire[family], partial[family])
            for family in ("assets", "animations", "scripts"):
                compare(name, "resources." + family, wire["resources"][family],
                        partial["resources"][family])
            global_properties = [property for property in wire["properties"]
                                 if property["scope"] == "global" and property["type"] != "message"]
            compare(name, "properties.global", global_properties, partial["globalProperties"])
            pending_messages = [property["id"] for property in wire["properties"]
                                if property["scope"] == "global" and property["type"] == "message"]
            compare(name, "properties.message-pending", pending_messages,
                    partial["unresolvedMessageVariables"])
            if name == "feature-lab":
                # The C++ compiler intentionally has not assigned Message IDs.
                # Still require the independently compiled reference to have
                # materialized an actual stable ID and corresponding catalog entry.
                assert pending_messages == ["story-message"], pending_messages
                property = next(item for item in wire["properties"]
                                if item["id"] == "story-message" and item["scope"] == "global")
                message = property["defaultValue"]
                assert message["kind"] == "message" and type(message["id"]) is int
                assert any(entry["messageId"] == message["id"]
                           for catalog in wire["localization"]["catalogs"]
                           for entry in catalog["entries"]), message
            compare(name, "diagnostics.supported", expected["diagnostics"],
                    data["loweringDiagnostics"])
            native_hash = invoke(binary, "--hash-compiled-stdin", stdin=json.dumps(wire))
            compare(name, "saveContract", wire["saveContract"], native_hash["saveContract"])
            missing = data["unsupportedFamilies"]
            assert "definitions" in missing and "resources.layouts" in missing
            print(f"{name}: PASS supported Project/Asset/Animation/Script/global Variable parity; "
                  f"UNIMPLEMENTED {', '.join(missing)}; "
                  f"reference messages={len(pending_messages)}, save={wire['saveContract']}")
            checked += 1
        assert checked >= 3
        # Verify mismatch reporting pinpoints the actual family and ordered index.
        assert difference(["a", "b"], ["b", "a"], "/resources/assets")[0] == "/resources/assets/0"
        print(f"Native compiled Project cold parity PASSED: {checked} supported-family cases; "
              "missing families explicitly excluded.")


if __name__ == "__main__":
    main()
