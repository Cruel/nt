"""Cold C++/TypeScript differential certification for #552–#554 (not a production compiler).

An authoritative C++ Project reader admits every case. A separately run TS
reference compiles only those admitted JSON generations; neither process reads
cached compiled runtime artifacts. Missing gameplay families are reported, never
silently counted as passing parity.
"""

import json
import os
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
        if os.environ.get("NOVELTEA_PARITY_INSPECT"):
            print(f"MISMATCH {case}: {pointer}: reference={str(left)[:200]!r}, native={str(right)[:200]!r}", flush=True)
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
                     "metadata-edge",
                     "source-drift", "lua-spacing", "rml-arguments", "selector-order",
                     "missing-entrypoint", "invalid-asset", "invalid-message",
                     "invalid-locale", "invalid-lua-arguments"):
            if os.environ.get("NOVELTEA_PARITY_CASES") and name not in os.environ["NOVELTEA_PARITY_CASES"].split(","):
                continue
            target = root / name
            if name in ("feature-lab", "source-drift", "lua-spacing", "rml-arguments",
                        "selector-order", "invalid-lua-arguments"):
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
            if name == "metadata-edge":
                # Small, independently admitted metadata witness: no warmed cache
                # and no unrelated Feature Lab gameplay definitions.
                (target / "traits.yaml").write_text(
                    "map-reader:\n  id: map-reader\n  label: Map reader\n"
                    "  ownerKinds:\n    - room\n  properties: []\n", encoding="utf-8")
                (target / "records/archetypes").mkdir(parents=True)
                shutil.copy2(fixture / "records/archetypes/runtime-workshop-room.yaml",
                             target / "records/archetypes/runtime-workshop-room.yaml")
                (target / "records/materials").mkdir(parents=True)
                shutil.copy2(fixture / "records/materials/lab-decorator.yaml",
                             target / "records/materials/lab-decorator.yaml")
                (target / "records/assets").mkdir(parents=True)
                shutil.copy2(fixture / "records/assets/pilot-room-backdrop.yaml",
                             target / "records/assets/pilot-room-backdrop.yaml")
                background = target / "assets/images/bedroom.webp"
                background.parent.mkdir(parents=True)
                shutil.copy2(fixture / "assets/images/bedroom.webp", background)
                layout = target / "records/layouts/effects-panel"
                layout.mkdir(parents=True)
                for source_file in (fixture / "records/layouts/effects-panel").iterdir():
                    shutil.copy2(source_file, layout / source_file.name)
                room = target / "records/rooms/starting-room.yaml"
                edit(room, "traits: []", "traits:\n  - map-reader")
                edit(room, "  displayName: Room starting-room\n",
                     "  displayName: Room starting-room\n  background:\n"
                     "    asset: pilot-room-backdrop\n")
                with room.open("a", encoding="utf-8") as output:
                    output.write(
                        "  features:\n"
                        "    - id: strip\n      label: Status strip\n"
                        "      traits: []\n      localProperties: []\n"
                        "      defaultProperties: []\n      inventories: []\n"
                        "  hotspots:\n"
                        "    - id: strip-hit\n      label: Status strip\n"
                        "      condition: always\n      inputOrder: 0\n"
                        "      highlight:\n        kind: default\n"
                        "      shape:\n        kind: rect\n"
                        "        bounds:\n          x: 0.1\n          \"y\": 0.2\n"
                        "          width: 0.3\n          height: 0.2\n"
                        "      target:\n        kind: owner-feature\n        featureId: strip\n"
                    )
                edit(target / "records/maps/overview.yaml", "data: {}",
                     "data:\n  locations:\n"
                     "    - id: start\n      room: starting-room\n      regions: []")
            if name == "source-drift":
                edit(target / "records/scenes/localized-story.yaml",
                     "Managed letter for {name}", "Révisé 😀 letter for {name}")
            if name == "lua-spacing":
                edit(target / "records/scenes/localized-story.yaml",
                     "Text.tr('Managed letter for {name}'",
                     "Text . tr('Managed letter for {name}'")
            if name == "rml-arguments":
                rml = target / "records/layouts/language-board/layout.rml"
                edit(rml, "</section></body></rml>",
                     '<p><nt-tr arg-name="Ada">New message {name}</nt-tr></p>'
                     "</section></body></rml>")
            if name == "selector-order":
                edit(target / "records/scenes/localized-story.yaml",
                     "Text.select('sealed'",
                     "Text.select('a', {A='Upper', a='Lower', other='Open'})); "
                     "noveltea.notify(Text.select('sealed'")
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
        required = {"feature-lab", "unicode-label", "ordering", "missing-entrypoint"}
        if os.environ.get("NOVELTEA_PARITY_CASES"):
            required &= set(os.environ["NOVELTEA_PARITY_CASES"].split(","))
        assert {entry["name"] for entry in admitted_cases} >= required
        reference_results = invoke("node", reference,
                                   stdin=json.dumps({"cases": admitted_cases}, ensure_ascii=False))
        references = {value["name"]: value for value in reference_results["results"]}
        if os.environ.get("NOVELTEA_PARITY_CAPTURE"):
            Path(os.environ["NOVELTEA_PARITY_CAPTURE"]).write_text(
                json.dumps({"cases": cases, "references": references}, ensure_ascii=False),
                encoding="utf-8")
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
            shared = partial["shared"]
            # The staged draft must not accidentally acquire a publishable wire header.
            assert "schema" not in shared and "schemaVersion" not in shared and \
                   "saveContract" not in shared, name
            if name == "metadata-edge":
                assert shared["traits"] and shared["archetypes"], name
                assert shared["resources"]["layouts"] and \
                       shared["resources"]["materialInterfaces"], name
                assert shared["definitions"]["rooms"][0]["hotspots"], name
                assert shared["definitions"]["maps"][0]["locations"], name
                assert shared["inventories"] == [] and shared["settings"]["inventory"], name
            if name == "feature-lab":
                unpublished = invoke(binary, "--verify-compiled-stdin",
                                     stdin=json.dumps(shared))
                assert unpublished["verified"] is False and unpublished["diagnostics"], unpublished
            for family in ("settings", "traits", "archetypes", "inventories",
                           "interactableInstances"):
                compare(name, family, wire[family], shared[family])
            for family in ("layouts", "materialInterfaces"):
                compare(name, "resources." + family, wire["resources"][family],
                        shared["resources"][family])
            for family in ("characters", "rooms", "interactables", "verbs",
                           "interactions", "scenes", "dialogues", "maps"):
                rows = []
                for source in wire["definitions"][family]:
                    value = dict(source)
                    for key in {"verbs": ("availability", "defaultProgram"),
                                "interactions": ("rules",),
                                "scenes": ("program", "terminal"),
                                "dialogues": ("program", "completion")}.get(family, ()):
                        value.pop(key, None)
                    if family == "rooms":
                        value["lifecycle"] = dict(value["lifecycle"])
                        value["lifecycle"].pop("hooks", None)
                        for program in ("beforeEnter", "afterEnter", "beforeLeave", "afterLeave",
                                        "onEnterRejected", "onLeaveRejected"):
                            value["lifecycle"][program] = []
                        value["exits"] = [{**exit, "onRejected": []} for exit in value["exits"]]
                    if family == "verbs":
                        value["offers"] = [{key: field for key, field in offer.items()
                                            if key != "condition"} for offer in value["offers"]]
                    if family == "dialogues":
                        value["stageSlots"] = []
                        value["mediaSlots"] = []
                    rows.append(value)
                compare(name, "definitions." + family, rows, shared["definitions"][family])
            compare(name, "properties", wire["properties"], shared["properties"])
            native_messages = partial["messages"]
            source = wire["localization"]["sourceLocale"]
            reference_catalogs = {catalog["locale"]: catalog["entries"]
                                  for catalog in wire["localization"]["catalogs"]}
            compare(name, "messages.source", reference_catalogs[source],
                    native_messages["sourceEntries"])
            compare(name, "messages.catalogs", reference_catalogs,
                    native_messages["catalogs"])
            if name in ("feature-lab", "source-drift", "lua-spacing", "rml-arguments",
                        "selector-order"):
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
            if name == "rml-arguments":
                assert any(entry["value"] == "New message {name}" and
                           entry.get("arguments") == [{"name": "name", "type": "printable"}]
                           for entry in native_messages["sourceEntries"]), name
            if name == "selector-order":
                assert any(entry.get("pattern", {}).get("nodes", [{}])[0].get("cases", [])[:2] ==
                           [{"key": "A", "node": 1}, {"key": "a", "node": 2}]
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
            assert "programs.room-scene" in missing and "programs.dialogue-interaction" in missing
            assert "properties.message" not in missing
            print(f"{name}: PASS supported shared gameplay/resource/Message parity; "
                  f"UNIMPLEMENTED {', '.join(missing)}; "
                  f"reference messages={len(reference_catalogs[source])}, save={wire['saveContract']}")
            checked += 1
        assert checked >= (1 if os.environ.get("NOVELTEA_PARITY_CASES") else 5)
        # An edited Lua literal may change its source text, but tracked source
        # identity must not silently receive a new package-local ID.
        if "source-drift" in cases and "feature-lab" in cases:
            stable = "48d01321-b758-5fcd-8380-42872aef0bd1"
            assert cases["feature-lab"]["native"]["messages"]["ids"][stable] == \
                   cases["source-drift"]["native"]["messages"]["ids"][stable]
        # Verify mismatch reporting pinpoints the actual family and ordered index.
        assert difference(["a", "b"], ["b", "a"], "/resources/assets")[0] == "/resources/assets/0"
        print(f"Native compiled Project cold parity PASSED: {checked} supported-family cases; "
              "missing families explicitly excluded.")


if __name__ == "__main__":
    main()
