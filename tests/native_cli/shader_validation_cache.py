"""Resident public-validation shader reuse, dependency and integrity certification."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory


cli = Path(sys.argv[1]).resolve()
fixture = Path(sys.argv[2]).resolve()

with TemporaryDirectory(prefix="noveltea-shader-validation-") as temporary:
    root = Path(temporary)
    project = root / "project"
    shutil.copytree(fixture, project, ignore=shutil.ignore_patterns(".noveltea"))
    env = {
        **os.environ,
        "NOVELTEA_VALIDATION_WORK_PROFILE": "1",
        "NOVELTEA_CLI_CERTIFICATION": "1",
        "NOVELTEA_CLI_CERTIFICATION_DAEMON_RUNTIME_ROOT": str(root / "daemon"),
    }
    env.pop("NOVELTEA_NO_DAEMON", None)

    def validate(success=True, local=False):
        process = subprocess.run(
            [str(cli), "--json", *(["--no-daemon"] if local else []),
             "--project", str(project), "validate"],
            env=env, capture_output=True, text=True, timeout=180)
        assert not process.stderr, process.stderr
        response = json.loads(process.stdout)
        assert response["success"] == success, (process.returncode, response)
        return response

    def work(response, name):
        return response["validationWork"].get(name, 0)

    def signature(response):
        return response["diagnostics"]

    shader = project / "shaders/lab-invert.fs.sc"
    common = project / "shaders/memo-common.sh"
    nested = project / "shaders/memo-nested.inc"
    nested.write_text("// shared shader leaf\n")
    common.write_text('#include "memo-nested.inc"\n')
    original = shader.read_text()
    shader.write_text(original.replace("#include <bgfx_shader.sh>",
                                       '#include <bgfx_shader.sh>\n#include "memo-common.sh"'))

    first = validate()
    assert work(first, "shaderCompileRuns") > 0, first["validationWork"]
    initial_diagnostics = signature(first)
    warm = validate()
    assert work(warm, "shaderCompileRuns") == 0, warm["validationWork"]
    assert work(warm, "shaderProgramsReused") > 0
    assert work(warm, "materialInputReuses") == 1
    assert work(warm, "materialInterfaceValidations") == 0
    assert work(warm, "materialInterfaceReuses") > 0
    assert signature(warm) == initial_diagnostics
    assert signature(validate(local=True)) == initial_diagnostics

    # Unrelated saved Room metadata must not prepare Materials or stage shaders.
    room = project / "records/rooms/feature-lab-home.yaml"
    room.write_text(room.read_text().replace(
        "label: Feature Lab Home", "label: Feature Lab Home - cache check"))
    label = validate()
    assert work(label, "shaderCompileRuns") == 0, label["validationWork"]
    assert work(label, "materialInputReuses") == 1
    assert work(label, "materialInterfaceValidations") == 0
    assert label["validationWork"]["endToEnd"]["materialShaderPreparations"] == 0
    assert signature(label) == initial_diagnostics

    # The canonical recursive resolver reports a nested dependency. Only its
    # consuming program loses cached evidence, not unrelated preset programs.
    nested.write_text("// edited shared shader leaf\n")
    changed = validate()
    assert work(changed, "shaderCompileRuns") == 1, changed["validationWork"]
    assert work(changed, "shaderProgramsReused") > 0
    assert work(changed, "materialInterfaceValidations") >= 1
    assert work(changed, "materialInterfaceReuses") > 0
    assert signature(changed) == initial_diagnostics
    assert work(validate(), "shaderCompileRuns") == 0

    # Missing-include is a deterministic negative result. Creation of the
    # missing leaf must revoke it even after a fresh native Project admission.
    nested.write_text('#include "memo-repaired.sh"\n')
    broken = validate(False)
    assert any("shader" in item["code"] for item in broken["diagnostics"]), broken
    repeat = validate(False)
    assert work(repeat, "shaderCompileRuns") == 0, repeat["validationWork"]
    (project / "shaders/memo-repaired.sh").write_text("// repaired\n")
    repaired = validate()
    assert work(repaired, "shaderCompileRuns") == 1, repaired["validationWork"]
    assert signature(repaired) == initial_diagnostics

    # Resident cache entries cannot hide a corrupted compiled binary.
    binaries = list((project / ".noveltea/build/shaders/derived").rglob("*.bin"))
    assert binaries
    # Nested-source edits leave prior compiled identities on disk. Damage the
    # newest emitted binary, not a stale output no current program references.
    target = max((p for p in binaries if p.stat().st_size),
                 key=lambda p: p.stat().st_mtime_ns)
    target.write_bytes(b"\xA5" * target.stat().st_size)
    corrupt = validate()
    assert work(corrupt, "shaderCompileRuns") >= 1, corrupt["validationWork"]
    assert signature(corrupt) == initial_diagnostics
    assert work(validate(), "shaderCompileRuns") == 0

    # A saved Material label is not a codegen or reflected-interface input.
    # This must not turn into shader compilation just because Material YAML
    # changed; the public diagnostic output remains identical.
    grade = project / "records/materials/lab-grade.yaml"
    original_grade = grade.read_text()
    grade.write_text(original_grade.replace(
        "label: Premultiplied green grade",
        "label: Premultiplied green grade (renamed)"))
    material_label = validate()
    assert work(material_label, "shaderCompileRuns") == 0, material_label["validationWork"]
    assert work(material_label, "materialInputReuses") == 1
    assert work(material_label, "materialInterfaceValidations") == 0
    assert material_label["validationWork"]["endToEnd"]["materialShaderPreparations"] == 0
    assert signature(material_label) == initial_diagnostics

    # Parameter-only edits change effective Material data (including inherited
    # children), but not shader source, variants or compiler program inputs.
    parent = project / "records/materials/engine2d-draw-contract.yaml"
    original_parent = parent.read_text()
    assert "value: 0.25" in original_parent
    parent.write_text(original_parent.replace("value: 0.25", "value: 0.35"))
    material_parameter = validate()
    assert work(material_parameter, "shaderCompileRuns") == 0, material_parameter["validationWork"]
    assert work(material_parameter, "shaderProgramsReused") > 0
    assert material_parameter["validationWork"]["endToEnd"]["materialShaderPreparations"] > 0
    # Only the parent and inheriting child require refreshed interface checks.
    assert work(material_parameter, "materialInterfaceValidations") == 2, material_parameter["validationWork"]
    assert signature(material_parameter) == initial_diagnostics

    # Changing a Material's fragment path to an already compiled request
    # should alias its outputs without recompiling unrelated programs.
    invert = project / "records/materials/lab-invert.yaml"
    original_invert = invert.read_text()
    original_fragment = "shaders/lab-invert.fs.sc"
    assert original_fragment in original_invert
    invert.write_text(original_invert.replace(original_fragment, "shaders/lab-grade.fs.sc"))
    shared_program = validate()
    assert work(shared_program, "shaderCompileRuns") == 0, shared_program["validationWork"]
    assert shared_program["validationWork"]["endToEnd"]["materialShaderPreparations"] > 0
    assert signature(shared_program) == initial_diagnostics

    # A new, valid Material shader choice invalidates only its program. Other
    # Material programs and cached reflection contributions must survive.
    alternative = project / "shaders/material-alternative.fs.sc"
    alternative.write_text(shader.read_text() + "\n// alternative Material source\n")
    invert.write_text(original_invert.replace(original_fragment,
                                               "shaders/material-alternative.fs.sc"))
    selected = validate()
    assert work(selected, "shaderCompileRuns") == 1, selected["validationWork"]
    assert selected["validationWork"]["endToEnd"]["materialShaderPreparations"] > 0
    assert work(selected, "shaderProgramsReused") > 0
    assert work(selected, "materialInterfaceReuses") > 0
    assert signature(selected) == initial_diagnostics
    assert work(validate(), "shaderCompileRuns") == 0

    # A Material reference to a missing shader must diagnose on its new YAML
    # path, never reuse the previous successful compiler evidence. Repairing
    # the Material restores diagnostics without restarting the daemon.
    invert.write_text(original_invert.replace(original_fragment,
                                               "shaders/material-does-not-exist.fs.sc"))
    missing_material_shader = validate(False)
    assert any("shader" in d["code"] and "missing" in d["code"]
               for d in signature(missing_material_shader)), missing_material_shader
    invert.write_text(original_invert)
    material_repaired = validate()
    assert signature(material_repaired) == initial_diagnostics
    assert work(material_repaired, "shaderCompileRuns") == 0, material_repaired["validationWork"]
    assert signature(validate(local=True)) == initial_diagnostics

    print("Resident shader validation cache certification passed")
