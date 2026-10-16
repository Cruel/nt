#include "material_semantics.hpp"
#include "room_session.hpp"

#include <jsoncons/json.hpp>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

namespace {
using namespace noveltea::authoring;
using Json = jsoncons::ojson;

void require(bool condition, std::string_view message)
{
    if (!condition)
        throw std::runtime_error(std::string(message));
}

bool has(const std::vector<Diagnostic>& diagnostics, std::string_view path)
{
    for (const auto& diagnostic : diagnostics)
        if (diagnostic.path == path)
            return true;
    return false;
}

std::string read(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    require(static_cast<bool>(input), "Cannot read Material fixture.");
    return {std::istreambuf_iterator<char>{input}, std::istreambuf_iterator<char>{}};
}

struct ProjectFixture {
    std::filesystem::path root;
    explicit ProjectFixture(const std::filesystem::path& source)
    {
        root = std::filesystem::temp_directory_path() /
               ("nt-489-" +
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::copy(source, root, std::filesystem::copy_options::recursive);
    }
    ~ProjectFixture()
    {
        std::error_code ignored;
        std::filesystem::remove_all(root, ignored);
    }
};

void certify(const std::filesystem::path& fixture_root)
{
    ProjectFixture fixture(fixture_root);
    std::string error;
    const auto lookup = [&](std::string_view family,
                            std::string_view id) -> std::optional<std::string> {
        auto record =
            RoomSession::open_record(fixture.root, std::string(family), std::string(id), error);
        if (!record || !record->snapshot().valid)
            return std::nullopt;
        return record->snapshot().normalized_json;
    };
    auto material = RoomSession::open_record(fixture.root, "materials", "lab-inherited", error);
    require(material != nullptr && material->snapshot().valid,
            "Native generated Material contract admits sparse inheritance");
    const auto inherited = resolve_material("lab-inherited", material->snapshot().normalized_json,
                                            lookup, fixture.root);
    require(inherited.accepted, "Derived Material resolves a valid ancestor chain");
    const auto resolved = Json::parse(inherited.effective_json);
    require(resolved.at("preset") == "engine-2d" && resolved.at("role") == "engine-2d" &&
                resolved.at("shader").at("fragmentSource") ==
                    "project:/shaders/engine2d-draw-contract.fs.sc" &&
                resolved.at("parameters").at("u_strength").at("value") == 0.25,
            "Derived Material inherits role, shader stage and typed parameter values");

    auto preset = RoomSession::open_record(fixture.root, "materials", "lab-invert", error);
    require(preset && preset->snapshot().valid,
            "Custom shader Material normalizes sparse defaults");
    const auto custom =
        resolve_material("lab-invert", preset->snapshot().normalized_json, lookup, fixture.root);
    require(custom.accepted && Json::parse(custom.effective_json).at("custom") == true,
            "Project shader override inherits Preset vertex/varying and custom fragment");
    const auto missing_source =
        preset->patch(0, {{RoomPatch::Operation::Replace, "/data/shader/fragment/path",
                           "\"shaders/does-not-exist.fs.sc\""}});
    require(missing_source.accepted && missing_source.snapshot.valid,
            "Representable source-path edits remain editable during draft authoring");
    const auto missing_resolved = resolve_material(
        "lab-invert", missing_source.snapshot.normalized_json, lookup, fixture.root);
    require(!missing_resolved.accepted &&
                has(missing_resolved.diagnostics, "/data/shader/fragment/path"),
            "Missing Material shader source diagnoses the owning source path");

    auto invalid = Json::parse(material->snapshot().normalized_json);
    invalid.at("data").at("base")["material"] =
        Json::parse(R"({"$ref":{"collection":"materials","id":"lab-inherited"}})");
    const auto cyclic =
        resolve_material("lab-inherited", invalid.to_string(), lookup, fixture.root);
    require(!cyclic.accepted && has(cyclic.diagnostics, "/data/base/material/$ref"),
            "Self-inheritance is rejected without recursive traversal");

    invalid = Json::parse(material->snapshot().normalized_json);
    invalid.at("data")["parameters"] =
        Json::parse(R"({"u_strength":{"type":"vec3","value":[1,2,3]}})");
    const auto mismatch =
        resolve_material("lab-inherited", invalid.to_string(), lookup, fixture.root);
    require(!mismatch.accepted && has(mismatch.diagnostics, "/data/parameters/u_strength/type"),
            "Child cannot reinterpret inherited parameter logical type");

    invalid = Json::parse(preset->snapshot().normalized_json);
    invalid.at("data")["shader"] = Json::object();
    auto invalid_override = validate_record("MaterialsRecord", invalid.to_string());
    require(!invalid_override.accepted && has(invalid_override.diagnostics, "/data/shader"),
            "Empty shader override is rejected by generated native operation");
    invalid.at("data").erase("shader");
    invalid.at("data")["textures"] = Json::parse(R"({"s_texColor":{}})");
    invalid_override = validate_record("MaterialsRecord", invalid.to_string());
    require(!invalid_override.accepted &&
                has(invalid_override.diagnostics, "/data/textures/s_texColor"),
            "Empty texture override is rejected by native refinement");

    auto project = ProjectSession::open(fixture.root, error);
    require(project != nullptr, error);
    auto inspected = project->inspect_record("materials/lab-inherited");
    require(inspected.accepted && inspected.snapshot.valid,
            "Project session cross-record Material resolution validates existing fixture");
    const auto shader_request = project->material_compiler_request("lab-inherited");
    require(shader_request.has_value(), "Native session prepares a compiler-program request");
    const auto program = Json::parse(*shader_request).at("programs").at("lab-inherited");
    require(
        program.at("vertexSource") == "engine:/vs_quad.sc" &&
            program.at("fragmentSource") == "project:/shaders/engine2d-draw-contract.fs.sc" &&
            program.at("interfaceContract") == "noveltea.material-preset:engine-2d:1" &&
            program.at("interfaceFingerprint").as<std::string>().starts_with("sha256:"),
        "Native program request uses the actual generated compiler contract and inherited stages");
    const auto initial_revision = project->snapshot().working_revision;
    auto edited =
        project->patch(initial_revision, {{RoomPatch::Operation::Add,
                                           "/materials/lab-inherited/data/parameters/u_strength",
                                           R"({"value":0.5})"}});
    require(edited.accepted && edited.snapshot.valid && edited.snapshot.dirty,
            "Material edit is admitted as an atomic working Project batch");
    const auto before_save = read(fixture.root / "records/materials/lab-inherited.yaml");
    const auto saved =
        project->save_owners(edited.snapshot.working_revision, {"materials/lab-inherited"}, false,
                             TransactionDecision::UseEditDecisions);
    require(saved.accepted && !saved.snapshot.dirty &&
                read(fixture.root / "records/materials/lab-inherited.yaml") != before_save,
            "Scoped Material Save changes only selected tracked YAML");
    auto reopened = RoomSession::open_record(fixture.root, "materials", "lab-inherited", error);
    require(reopened && reopened->snapshot().valid &&
                Json::parse(reopened->snapshot().normalized_json)
                        .at("data")
                        .at("parameters")
                        .at("u_strength")
                        .at("value") == 0.5,
            "Reopened Material preserves sparse override semantics");

    const auto shader_path = fixture.root / "shaders/engine2d-draw-contract.fs.sc";
    const auto source_before = read(shader_path);
    auto staged = project->stage_shader_source(project->snapshot().working_revision,
                                               "shaders/engine2d-draw-contract.fs.sc",
                                               source_before + "\n// unsaved test\n");
    require(
        staged.accepted && staged.snapshot.dirty &&
            project->shader_source_overlays().contains("shaders/engine2d-draw-contract.fs.sc") &&
            read(shader_path) == source_before,
        "Dirty shader overlay is revisioned and does not rewrite source bytes");
    auto obsolete = project->publish_material_compiler_result(initial_revision, "lab-inherited",
                                                              R"({"ok":true,"diagnostics":[]})");
    require(!obsolete.accepted, "Late compiler results cannot validate a newer shader revision");
    const auto compile_failure = project->publish_material_compiler_result(
        staged.snapshot.working_revision, "lab-inherited",
        R"({"ok":true,"success":false,"diagnostics":[{"severity":"error","code":"compiler_failed","sourcePath":"shaders/engine2d-draw-contract.fs.sc","message":"syntax failure"}]})");
    require(compile_failure.accepted && !compile_failure.snapshot.valid &&
                has(compile_failure.snapshot.diagnostics, "/materials/lab-inherited/data/shader") &&
                compile_failure.snapshot.diagnostics.back().source_path ==
                    "shaders/engine2d-draw-contract.fs.sc",
            "Existing native compiler diagnostics carry physical source provenance");
    const auto reflection = validate_material_shader_compiler_result(
        R"({"ok":true,"success":true,"diagnostics":[],"outputs":[{"reflectedInputs":[{"name":"u_strength","kind":"uniform","type":"vec2","arraySize":1,"registerIndex":0,"registerCount":1}]}]})",
        "lab-inherited", inherited.effective_json);
    require(!reflection.accepted &&
                has(reflection.diagnostics, "/materials/lab-inherited/data/parameters/u_strength"),
            "Native shader compiler reflection cannot redefine an author uniform as vec2");
    auto restored =
        project->stage_shader_source(project->snapshot().working_revision,
                                     "shaders/engine2d-draw-contract.fs.sc", source_before);
    require(restored.accepted && project->shader_source_overlays().empty() &&
                restored.snapshot.valid && read(shader_path) == source_before,
            "Removing dirty overlay invalidates stale compiler diagnostics");
    const auto new_shader = std::string("shaders/new-unsaved.fs.sc");
    const auto new_source = project->stage_shader_source(project->snapshot().working_revision,
                                                         new_shader, "// unsaved shader draft");
    require(new_source.accepted && new_source.snapshot.dirty &&
                !std::filesystem::exists(fixture.root / new_shader) &&
                project->shader_source_overlays().contains(new_shader),
            "New unsaved shader source can be staged without creating physical bytes");
    const auto removed_source =
        project->stage_shader_source(new_source.snapshot.working_revision, new_shader, "");
    require(removed_source.accepted && removed_source.snapshot.valid &&
                !removed_source.snapshot.dirty && project->shader_source_overlays().empty(),
            "Discarding an unsaved shader draft restores the clean Project source generation");
}
} // namespace

int main(int argc, char** argv)
{
    if (argc != 2)
        return 2;
    try {
        certify(argv[1]);
        std::cout << "Native Material certification passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
