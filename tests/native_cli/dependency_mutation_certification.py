"""#595: live public-CLI dependency mutation and avoided-work certification.

Usage: python3 dependency_mutation_certification.py <noveltea> <repo-root>
       [2|101|501|feature-lab ...]

This intentionally remains RED for known broad-invalidation defects (#596-599).
Diagnostic equality is independently checked against a cache-free --no-daemon
copy. Work contracts (not machine-specific time limits) enforce incrementality.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

cli = Path(sys.argv[1]).resolve()
repo = Path(sys.argv[2]).resolve()
failures = []
checks = 0


def require(condition, name, detail):
    global checks
    checks += 1
    if not condition:
        failures.append((name, str(detail)[:700]))
        print(f"FAIL {name}: {str(detail)[:500]}", flush=True)


with tempfile.TemporaryDirectory(prefix="nt-dependency-mutation-") as directory:
    root = Path(directory)
    env = {k: v for k, v in os.environ.items()
           if k not in ("NOVELTEA_NO_DAEMON", "NOVELTEA_VALIDATION_WORK_PROFILE")}
    env.update(NOVELTEA_VALIDATION_WORK_PROFILE="1",
               NOVELTEA_CLI_CERTIFICATION="1",
               NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT=str(root / "daemon"))

    def invoke(*arguments):
        result = subprocess.run([str(cli), "--json", *map(str, arguments)],
                                env=env, capture_output=True, text=True, timeout=180)
        assert not result.stderr, (arguments, result.stderr[:900])
        payload = json.loads(result.stdout)
        assert payload["exitCode"] == result.returncode, (arguments, payload, result.returncode)
        return payload

    def validate(project, direct=False):
        args = ["--no-daemon"] if direct else []
        return invoke(*args, "--project", project, "validate")

    def public(value):
        # Includes the complete ordered diagnostics, source URLs/locations and
        # exit status, not just diagnostic codes or success.
        return {k: value.get(k) for k in
                ("success", "exitCode", "diagnostics", "error", "code")}

    def parity(project, observed, case):
        reference = root / "reference"
        if reference.exists():
            shutil.rmtree(reference)
        shutil.copytree(project, reference, symlinks=True,
                        ignore=shutil.ignore_patterns(".noveltea"))
        expected = validate(reference, direct=True)
        require(public(observed) == public(expected),
                case + ":fresh-parity",
                (public(observed)["diagnostics"][:2],
                 public(expected)["diagnostics"][:2]))

    def mutation(project, case, *, expected_valid=None, owners=None,
                 invalidated=None,
                 contributions=None, max_yaml=None, max_reads=None,
                 max_global=None, max_admissions=None, shader_runs=None,
                 allow_cold=False):
        # The resident may temporarily reject a generation during a physical
        # directory rename. Stable bytes must converge without daemon restart.
        for attempt in range(20):
            response = validate(project)
            if not any(d.get("code") == "WORKSPACE_REVISION_CONFLICT"
                       for d in response.get("diagnostics", [])):
                break
            time.sleep(0.1)
        else:
            raise AssertionError((case, "Stable generation never converged"))
        parity(project, response, case)
        if expected_valid is not None:
            require(response["success"] == expected_valid, case + ":validity",
                    response["diagnostics"][:3])
        work = response.get("validationWork", {})
        physical = work.get("endToEnd", {})
        if not allow_cold:
            require(work.get("coldValidationFallback") is False,
                    case + ":no-cold-fallback",
                    (work.get("coldValidationFallback", "<missing>"),
                     work.get("semanticFallbackReasons"),
                     physical.get("parsedYaml")))
        elif work.get("coldValidationFallback"):
            require("cold-invalid-project-admission" in
                    work.get("semanticFallbackReasons", ()),
                    case + ":cold-fallback-attributed", work)
        if owners is not None:
            require(set(work.get("recheckedRecordOwners", ())) == set(owners),
                    case + ":parsed-owners", work.get("recheckedRecordOwners", "<missing>"))
            require(work.get("recheckedRecords", -1) == len(owners),
                    case + ":parsed-count", work.get("recheckedRecords", "<missing>"))
        if invalidated is not None:
            require(set(work.get("invalidatedOwners", ())) == set(invalidated),
                    case + ":invalidated-owners",
                    work.get("invalidatedOwners", "<missing>"))
        if contributions is not None:
            require(set(work.get("recheckedContributionOwners", ())) == set(contributions),
                    case + ":semantic-owners", work.get("recheckedContributionOwners", "<missing>"))
        if max_yaml is not None:
            require(physical.get("parsedYaml", 10**9) <= max_yaml,
                    case + ":yaml-work", physical.get("parsedYaml", "<missing>"))
        if max_reads is not None and sys.platform.startswith("linux"):
            require(physical.get("fileByteReads", 10**9) <= max_reads,
                    case + ":read-work", physical.get("fileByteReads", "<missing>"))
        if max_global is not None:
            require(work.get("globalStageExecutions", 10**9) <= max_global,
                    case + ":global-stages",
                    (work.get("globalStageExecutions"), work.get("semanticFallbackReasons")))
        if max_admissions is not None:
            require(work.get("sessionAdmissions", 10**9) <= max_admissions,
                    case + ":resident-admission", work.get("sessionAdmissions", "<missing>"))
        if shader_runs is not None:
            require(work.get("shaderCompileRuns", -1) == shader_runs,
                    case + ":shader-compilations", work.get("shaderCompileRuns", "<missing>"))
        return response

    def stop():
        assert invoke("daemon", "stop")["success"]

    def make_room(project, name, template):
        (project / "records/rooms" / f"{name}.yaml").write_text(
            template.replace("id: destination", f"id: {name}", 1))

    def set_exit(text, target):
        return text.replace("data:\n",
                            "data:\n  exits:\n    - id: route\n"
                            "      label: Go east\n      direction: east\n"
                            f"      target: {target}\n", 1)

    def room_cases(size):
        project = root / f"rooms-{size}"
        assert invoke("--no-daemon", "project", "create",
                      project, "--name", "Dependency certification")["success"]
        for name in ("entry", "destination"):
            assert invoke("--no-daemon", "--project", project,
                          "entity", "create", "rooms", name)["success"]
        destination = project / "records/rooms/destination.yaml"
        template = destination.read_text()
        entry = project / "records/rooms/entry.yaml"
        entry_orig = entry.read_text()
        linked = set_exit(entry_orig, "destination")
        entry.write_text(linked)
        for i in range(size - 2):
            make_room(project, f"other-{i}", template)
        with (project / "project.yaml").open("a") as manifest:
            manifest.write("\nentrypoint: { kind: room, id: entry }\n")
        stop()
        initial = validate(project)
        require(initial["success"], f"{size}:baseline", initial["diagnostics"][:3])
        parity(project, initial, f"{size}:baseline")
        admission = initial["validationWork"].get("sessionAdmissions", 0)
        require(admission >= 1, f"{size}:initial-admission", admission)
        # Stable, unchanged warm responses must do no semantic work.
        mutation(project, f"{size}:unchanged", owners=[], contributions=[],
                 max_yaml=0, max_global=0, max_admissions=admission)

        entry.write_text(linked.replace("target: destination", "target: absent-room"))
        changed = mutation(project, f"{size}:rewire-to-missing", expected_valid=False,
                           owners={"rooms/entry"}, contributions={"rooms/entry"},
                           invalidated={"rooms/entry"},
                           max_yaml=1, max_reads=3, max_admissions=admission)
        require(any(d.get("code") == "reference.missing" and
                    d["path"].startswith("/rooms/entry/") for d in changed["diagnostics"]),
                f"{size}:missing-exit-diagnostic", changed["diagnostics"][:3])
        entry.write_text(linked)
        mutation(project, f"{size}:rewire-repair", expected_valid=True,
                 owners={"rooms/entry"}, contributions={"rooms/entry"},
                 invalidated={"rooms/entry"},
                 max_yaml=1, max_reads=3, max_admissions=admission)

        # A deletion must affect the old target and its dependent entry,
        # without parsing any of the unrelated 499 Room YAML files.
        destination.unlink()
        mutation(project, f"{size}:delete-target", expected_valid=False,
                 owners=set(), contributions={"rooms/entry"},
                 invalidated={"rooms/entry", "rooms/destination"},
                 max_yaml=4, max_reads=10, max_admissions=admission)
        mutation(project, f"{size}:unchanged-missing", expected_valid=False,
                 owners=[], contributions=[], max_yaml=0, max_global=0,
                 max_admissions=admission)
        destination.write_text(template)
        mutation(project, f"{size}:restore-target", expected_valid=True,
                 owners={"rooms/destination"}, contributions={"rooms/entry", "rooms/destination"},
                 invalidated={"rooms/entry", "rooms/destination"},
                 max_yaml=4, max_reads=10, max_admissions=admission)

        moved = project / "records/rooms/renamed-destination.yaml"
        moved.write_text(template.replace("id: destination", "id: renamed-destination", 1))
        destination.unlink()
        mutation(project, f"{size}:rename-target", expected_valid=False,
                 max_yaml=4, max_reads=10, max_admissions=admission)
        moved.unlink()
        destination.write_text(template)
        mutation(project, f"{size}:undo-rename", expected_valid=True,
                 max_yaml=4, max_reads=10, max_admissions=admission)

        # Simultaneous saved-file edits must both participate in the same
        # observed generation, without reparsing unrelated owners.
        destination.write_text(template.replace("label:", "label: Changed ", 1))
        entry.write_text(linked.replace("target: destination", "target: absent-room"))
        mutation(project, f"{size}:two-edits", expected_valid=False,
                 owners={"rooms/destination", "rooms/entry"},
                 max_yaml=2, max_reads=5, max_admissions=admission)
        entry.write_text(linked)
        destination.write_text(template)
        mutation(project, f"{size}:two-edits-repair", expected_valid=True,
                 max_yaml=2, max_reads=5, max_admissions=admission)

        if size > 2:
            # Two consumers of one target, with a further Room pointing to
            # one of those consumers. A missing destination invalidates the
            # two direct references, not every vertex in the reachable graph.
            shared = project / "records/rooms/other-0.yaml"
            shared_original = shared.read_text()
            shared.write_text(set_exit(shared_original, "destination"))
            mutation(project, f"{size}:shared-reference", expected_valid=True,
                     owners={"rooms/other-0"}, max_yaml=1,
                     max_admissions=admission)
            if size > 3:
                chain = project / "records/rooms/other-1.yaml"
                chain_original = chain.read_text()
                chain.write_text(set_exit(chain_original, "other-0"))
                mutation(project, f"{size}:dependency-chain", expected_valid=True,
                         owners={"rooms/other-1"}, max_yaml=1,
                         max_admissions=admission)
                # Cyclic references are finite graph identities, never an
                # unbounded recursive validation cascade.
                destination.write_text(set_exit(template, "other-1"))
                mutation(project, f"{size}:cycle", expected_valid=True,
                         owners={"rooms/destination"}, max_yaml=1,
                         max_admissions=admission)
                destination.write_text(template)
                mutation(project, f"{size}:cycle-repair", expected_valid=True,
                         owners={"rooms/destination"}, max_yaml=1,
                         max_admissions=admission)

            destination.unlink()
            missing_shared = mutation(project, f"{size}:shared-target-delete",
                                      expected_valid=False, max_yaml=4, max_reads=10,
                                      max_admissions=admission)
            for consumer in ("entry", "other-0"):
                require(any(d.get("code") == "reference.missing" and
                            d["path"].startswith(f"/rooms/{consumer}/")
                            for d in missing_shared["diagnostics"]),
                        f"{size}:{consumer}-missing", missing_shared["diagnostics"][:6])
            destination.write_text(template)
            mutation(project, f"{size}:shared-target-restore", expected_valid=True,
                     max_yaml=4, max_admissions=admission)
            shared.write_text(shared_original)
            mutation(project, f"{size}:shared-reference-remove", expected_valid=True,
                     owners={"rooms/other-0"}, max_yaml=1,
                     max_admissions=admission)
            if size > 3:
                chain.write_text(chain_original)
                mutation(project, f"{size}:chain-remove", expected_valid=True,
                         owners={"rooms/other-1"}, max_yaml=1,
                         max_admissions=admission)

        # Membership insertion and identity collision are different cases.
        independent = project / "records/rooms/added-room.yaml"
        independent.write_text(template.replace("id: destination", "id: added-room", 1))
        mutation(project, f"{size}:add-unreferenced", expected_valid=True,
                 max_yaml=3, max_admissions=admission)
        independent.unlink()
        mutation(project, f"{size}:delete-unreferenced", expected_valid=True,
                 max_yaml=3, max_admissions=admission)
        duplicate = project / "records/rooms/duplicate-room.yaml"
        duplicate.write_text(template)
        # An inadmissible duplicate identity may legitimately need cold
        # diagnostic recovery; ordinary missing references may not.
        mutation(project, f"{size}:duplicate-id", expected_valid=False,
                 allow_cold=True)
        duplicate.unlink()
        mutation(project, f"{size}:duplicate-repair", expected_valid=True,
                 max_yaml=3, max_admissions=admission)
        print(f"COMPLETE room mutation fixture {size}", flush=True)

    def file_cases():
        project = root / "feature-lab"
        shutil.copytree(repo / "tests/projects/feature-lab", project,
                        ignore=shutil.ignore_patterns(".noveltea"))
        stop()
        initial = validate(project)
        require(initial["success"], "feature-lab:baseline", initial["diagnostics"][:3])
        admission = initial["validationWork"].get("sessionAdmissions", 0)
        # Pure text edits have source-owner impact but no reparse of YAML
        # records or Project-wide semantic invalidation.
        for name, relative, edit, expected_shader_runs in (
            ("lua", "records/layouts/feature-lab-hud/layout.lua",
             lambda s: s + "\n-- dependency certification\n", 0),
            ("rml", "records/layouts/feature-lab-hud/layout.rml",
             lambda s: s.replace("<title>Feature Lab</title>",
                                 "<title>Dependency Certification</title>", 1), 0),
            ("rcss", "records/layouts/feature-lab-hud/layout.rcss",
             lambda s: s + "\n/* dependency certification */\n", 0),
            ("shader", "shaders/lab-invert.fs.sc",
             lambda s: s.replace("source.rgb, source.a",
                                 "source.rgb * 1.001, source.a", 1), 1),
        ):
            path = project / relative
            old = path.read_text()
            new = edit(old)
            assert new != old, (name, relative)
            path.write_text(new)
            mutation(project, f"feature-lab:{name}", expected_valid=True,
                     owners=set(), max_yaml=0, max_reads=12,
                     max_global=0, max_admissions=admission,
                     shader_runs=expected_shader_runs)
            path.write_text(old)
            mutation(project, f"feature-lab:{name}-repair", expected_valid=True,
                     max_yaml=0, max_reads=12, max_admissions=admission)

        # An Asset-backed shared stylesheet is separately tracked from the
        # RML document that references it. CSS bytes cannot invalidate an
        # unchanged parent document's semantic/reference analysis.
        stylesheet = project / "assets/ui/shared.rcss"
        before_style = stylesheet.read_text()
        stylesheet.write_text(before_style + "\n/* shared CSS mutation */\n")
        mutation(project, "feature-lab:shared-rcss", expected_valid=True,
                 owners=set(), max_yaml=0, max_reads=12,
                 max_global=0, max_admissions=admission)
        stylesheet.write_text(before_style)
        mutation(project, "feature-lab:shared-rcss-repair", expected_valid=True,
                 max_yaml=0, max_reads=12, max_admissions=admission)

        # The source recognizer admits static import(...) relationships. A
        # missing import may affect reference-management diagnostics, but
        # must not make every record a semantic validation dependency.
        script = project / "scripts/notice-board.lua"
        before_script = script.read_text()
        script.write_text(before_script + '\nimport("nonexistent-module")\n')
        mutation(project, "feature-lab:lua-import", owners=set(),
                 max_yaml=0, max_reads=12, max_global=0,
                 max_admissions=admission)
        script.write_text(before_script)
        mutation(project, "feature-lab:lua-import-repair", expected_valid=True,
                 max_yaml=0, max_reads=12, max_admissions=admission)

        # An unrelated binary Asset must revoke its physical-source stage,
        # without reparsing hundreds of record sources.
        media = project / "assets/audio/notification.mp3"
        original = media.read_bytes()
        media.write_bytes(original + b"\x00")
        mutation(project, "feature-lab:asset-bytes", expected_valid=True,
                 max_yaml=0, max_admissions=admission)
        media.write_bytes(original)
        mutation(project, "feature-lab:asset-repair", expected_valid=True,
                 max_yaml=0, max_admissions=admission)

        # A project-level input and localization/trait changes are allowed to
        # widen only to their declared global consumers. Demand parity here;
        # source-specific tests above demand small affected-work bounds.
        for name, relative in (
            ("project", "project.yaml"),
            ("traits", "traits.yaml"),
            ("messages", "i18n/messages.yaml"),
            ("material", "records/materials/lab-invert.yaml"),
        ):
            path = project / relative
            source = path.read_text()
            path.write_text(source + "\n# dependency certification\n")
            mutation(project, f"feature-lab:{name}-metadata",
                     expected_valid=True)
            path.write_text(source)
            mutation(project, f"feature-lab:{name}-metadata-repair",
                     expected_valid=True)

        # Exercise actual semantic input changes, not only comment edits.
        # These may have genuinely wider consumers than the text-only
        # operations above; correctness and attribution take precedence.
        for name, relative, old_text, new_text in (
            ("entrypoint", "project.yaml",
             "id: feature-lab-home\ninventories:",
             "id: director-annex\ninventories:"),
            ("project-settings", "project.yaml",
             "startLabel: Open Feature Lab",
             "startLabel: Open Feature Lab Certification"),
            ("named-message", "i18n/messages.yaml",
             "source: Read the letter", "source: Read the journal"),
            ("trait-default", "traits.yaml",
             "defaultValue: trait-default\n",
             "defaultValue: changed-trait-default\n"),
        ):
            path = project / relative
            source = path.read_text()
            assert source.count(old_text) == 1, (name, old_text)
            path.write_text(source.replace(old_text, new_text, 1))
            mutation(project, f"feature-lab:{name}-changed", expected_valid=True)
            path.write_text(source)
            mutation(project, f"feature-lab:{name}-restored", expected_valid=True)
        print("COMPLETE Feature Lab source mutation fixture", flush=True)

    selected = set(sys.argv[3:]) if len(sys.argv) > 3 else {
        "2", "101", "501", "feature-lab"
    }
    assert selected and selected <= {"2", "101", "501", "feature-lab"}, selected
    try:
        for size in (2, 101, 501):
            if str(size) in selected:
                room_cases(size)
        if "feature-lab" in selected:
            file_cases()
    finally:
        stop()

print(f"Dependency mutation certification: {checks} assertions, {len(failures)} failures")
if failures:
    for name, detail in failures:
        print(f"  {name}: {detail}")
    raise AssertionError(f"{len(failures)} incremental work contracts failed (#596-599)")
print("All dependency mutation contracts passed")
