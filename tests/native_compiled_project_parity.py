"""Cold C++/TypeScript differential certification for #552/#553 (not a production compiler).

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
        for name in ("feature-lab", "unicode-label", "ordering", "duplicate-text",
                     "source-drift", "lua-spacing", "missing-entrypoint", "invalid-asset",
                     "invalid-message", "invalid-locale", "invalid-lua-arguments"):
            target = root / name
            if name in ("feature-lab", "source-drift", "lua-spacing", "invalid-lua-arguments"):
                copy_project(target)
            else:
                create_small(target, with_entrypoint=name != "missing-entrypoint")
            if name == "unicode-label":
                variable = target / "records/variables/alpha.yaml"
                edit(variable, "label: Variable alpha", 'label: "Unicode ☕ 漢字 😀"')
                edit(target / "records/rooms/starting-room.yaml", "displayName: Room starting-room",
                     'displayName: "ユニコード ☕ 😀"')
            if name == "ordering":
                # Creation order is zeta then alpha; compilation sorts by id.
                assert (target / "records/variables/zeta.yaml").is_file()
                assert (target / "records/variables/alpha.yaml").is_file()
            if name == "duplicate-text":
                source_room = target / "records/rooms/starting-room.yaml"
                duplicate = target / "records/rooms/second-room.yaml"
                duplicate.write_text(source_room.read_text(encoding="utf-8")
                                     .replace("id: starting-room", "id: second-room")
                                     .replace("label: Room starting-room", "label: Second Room"),
                                     encoding="utf-8")
            if name == "source-drift":
                edit(target / "records/scenes/localized-story.yaml",
                     "Managed letter for {name}", "Révisé 😀 letter for {name}")
            if name == "lua-spacing":
                edit(target / "records/scenes/localized-story.yaml",
                     "Text.tr('Managed letter for {name}'",
                     "Text . tr('Managed letter for {name}'")
            if name == "invalid-lua-arguments":
                edit(target / "records/scenes/localized-story.yaml",
                     "Text.msg('lab.greeting', {name='Ada'})",
                     "Text.msg('lab.greeting', {wrong='Ada'})")
            if name == "invalid-message":
                edit(target / "records/variables/alpha.yaml", "type: boolean\n  value: false",
                     "type: message\n  value:\n    $message: missing.key")
            if name == "invalid-locale":
                edit(target / "i18n/project.yaml", "sourceLocale: en", "sourceLocale: zz-Invalid")
            if name == "invalid-asset":
                for asset_id in ("zz-bad", "aa-bad"):
                    asset = target / "records/assets" / f"{asset_id}.yaml"
                    asset.parent.mkdir(parents=True, exist_ok=True)
                    source_text = (fixture / "records/assets/ui-pattern.yaml").read_text()
                    asset.write_text(source_text.replace("id: ui-pattern", f"id: {asset_id}")
                                     .replace("kind: image", "kind: invalid-kind"))

            admitted = invoke(binary, str(target), "--emit-parity")
            cases[name] = admitted
            assert not (target / ".noveltea/cache/runtime").exists(), (
                f"{name}: cold parity may not create or consume runtime cache")

        admitted_cases = [{"name": name, "project": data["project"]}
                          for name, data in cases.items()
                          if "project" in data and (data["ok"] or name == "missing-entrypoint")]
        assert {entry["name"] for entry in admitted_cases} >= {"feature-lab", "unicode-label",
                                                                  "ordering", "missing-entrypoint"}, cases
        reference_results = invoke("node", reference,
                                   stdin=json.dumps({"cases": admitted_cases}, ensure_ascii=False))
        references = {value["name"]: value for value in reference_results["results"]}
        checked = 0
        for name, data in cases.items():
            if not data["ok"]:
                assert name in {"missing-entrypoint", "invalid-asset", "invalid-message",
                                "invalid-locale", "invalid-lua-arguments"}, (name, data)
                assert data["diagnostics"], (name, data)
                if name == "missing-entrypoint":
                    assert not references[name]["ok"], name
                    reference_diagnostics = [
                        {"code": item["code"], "severity": item["severity"],
                         "path": item["jsonPointer"], "message": item["message"]}
                        for item in references[name]["diagnostics"]]
                    compare(name, "diagnostics.entrypoint", reference_diagnostics,
                            data["diagnostics"])
                elif name == "invalid-asset":
                    invalid_asset_paths = [diagnostic["path"] for diagnostic in data["diagnostics"]
                                           if diagnostic.get("code") == "schema.enum"]
                    assert invalid_asset_paths == ["/assets/aa-bad/data/kind",
                                                   "/assets/zz-bad/data/kind"], data["diagnostics"]
                elif name == "invalid-message":
                    assert any("/variables/alpha" in item.get("path", "")
                               for item in data["diagnostics"]), data["diagnostics"]
                elif name == "invalid-lua-arguments":
                    assert any("/scenes/localized-story" in item.get("path", "")
                               for item in data["diagnostics"]), data["diagnostics"]
                else:
                    assert any("localization" in item.get("path", "")
                               for item in data["diagnostics"]), data["diagnostics"]
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
                                 if property["scope"] == "global"]
            compare(name, "properties.global", global_properties, partial["globalProperties"])
            native_messages = partial["messages"]
            source = wire["localization"]["sourceLocale"]
            reference_catalogs = {catalog["locale"]: catalog["entries"]
                                  for catalog in wire["localization"]["catalogs"]}
            compare(name, "messages.source", reference_catalogs[source],
                    native_messages["sourceEntries"])
            compare(name, "messages.catalogs", reference_catalogs,
                    native_messages["catalogs"])
            if name in ("feature-lab", "source-drift", "lua-spacing"):
                # The global Message Variable is now a numeric runtime value,
                # not an unresolved authored key or a warmed runtime-cache ref.
                property = next(item for item in wire["properties"]
                                if item["id"] == "story-message" and item["scope"] == "global")
                message = property["defaultValue"]
                assert message["kind"] == "message" and type(message["id"]) is int
                assert any(entry["messageId"] == message["id"]
                           for catalog in wire["localization"]["catalogs"]
                           for entry in catalog["entries"]), message
                scene = next(item for item in wire["definitions"]["scenes"]
                             if item["id"] == "localized-story")
                events = {item["id"]: item["instruction"]
                          for item in scene["program"]["events"]}
                prefix = "/scenes/localized-story/data/events/"
                for path, expected_lua in (
                    (prefix + "0/source", events["realize"]["source"]),
                    (prefix + "1/text/source/source", events["story"]["text"]["source"]["source"]),
                    (prefix + "2/source", events["read-count"]["source"]),
                ):
                    compare(name, "messages.managedLua." + path, expected_lua,
                            native_messages["managedSources"][path])
                for path, compiled in (
                    (prefix + "@story/text", events["story"]["text"]),
                    (prefix + "@choice/options/@read/label",
                     events["choice"]["options"][0]["label"]),
                    (prefix + "@end/text", events["end"]["text"]),
                ):
                    compare(name, "messages.structuredText." + path, compiled,
                            native_messages["compiledTexts"][path])
                layouts = {item["id"]: item for item in wire["resources"]["layouts"]}
                for layout_id in ("lab-pause", "language-board"):
                    path = f"/layouts/{layout_id}/data/rml/sourceText"
                    compare(name, "messages.rml." + path,
                            layouts[layout_id]["rml"]["text"], native_messages["rmlSources"][path])
                path = "/layouts/language-board/data/lua/sourceText"
                compare(name, "messages.layoutLua." + path,
                        layouts["language-board"]["lua"]["text"],
                        native_messages["managedSources"][path])
                if name == "source-drift":
                    assert any("Révisé 😀 letter for {name}" == entry["value"]
                               for entry in native_messages["sourceEntries"]), name
            if name == "duplicate-text":
                source_text = [entry for entry in native_messages["sourceEntries"]
                               if entry["value"] == "Room starting-room"]
                assert len(source_text) == 2 and source_text[0]["messageId"] != source_text[1]["messageId"]
            if name == "unicode-label":
                assert any(entry["value"] == "ユニコード ☕ 😀"
                           for entry in native_messages["sourceEntries"]), name
            compare(name, "diagnostics.supported", expected["diagnostics"],
                    data["loweringDiagnostics"])
            verified = invoke(binary, "--verify-compiled-stdin", stdin=json.dumps(wire))
            assert verified["verified"], (name, verified.get("diagnostics"))
            compare(name, "saveContract", wire["saveContract"], verified["saveContract"])
            if name == "feature-lab":
                malformed_wire = {**wire, "schemaVersion": -1}
                rejected = invoke(binary, "--verify-compiled-stdin",
                                  stdin=json.dumps(malformed_wire))
                assert rejected["verified"] is False and rejected["diagnostics"], rejected
                assert rejected["diagnostics"][0]["path"] == "/schemaVersion", rejected
            missing = data["unsupportedFamilies"]
            assert "definitions" in missing and "resources.layouts" in missing
            assert "properties.message" not in missing
            print(f"{name}: PASS supported Project/Asset/Animation/Script/global Variable/Message parity; "
                  f"UNIMPLEMENTED {', '.join(missing)}; "
                  f"reference messages={len(reference_catalogs[source])}, save={wire['saveContract']}")
            checked += 1
        assert checked >= 5
        # An edited Lua literal may change its source text, but tracked source
        # identity must not silently receive a new package-local ID.
        stable = "48d01321-b758-5fcd-8380-42872aef0bd1"
        assert cases["feature-lab"]["native"]["messages"]["ids"][stable] == \
               cases["source-drift"]["native"]["messages"]["ids"][stable]
        # Verify mismatch reporting pinpoints the actual family and ordered index.
        assert difference(["a", "b"], ["b", "a"], "/resources/assets")[0] == "/resources/assets/0"
        print(f"Native compiled Project cold parity PASSED: {checked} supported-family cases; "
              "missing families explicitly excluded.")


if __name__ == "__main__":
    main()
