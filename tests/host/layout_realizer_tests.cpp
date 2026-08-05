#include "host/focused_preview_presenter.hpp"
#include "host/layout_realizer.hpp"
#include "host/presentation_layout_reconciler.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include "noveltea/core/compiled_project_codec.hpp"
#include "fake_script_source.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <type_traits>
#include <unordered_set>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

namespace noveltea::host {

using presentation::RuntimeLayoutBuiltinDocument;
using presentation::RuntimeLayoutMemorySource;
using presentation::RuntimeLayoutProjectSource;
using presentation::RuntimeMountedLayout;

static_assert(!std::is_copy_constructible_v<LayoutRealizer>);
static_assert(!std::is_copy_assignable_v<LayoutRealizer>);
static_assert(!std::is_move_constructible_v<LayoutRealizer>);
static_assert(!std::is_move_assignable_v<LayoutRealizer>);
static_assert(!std::is_copy_constructible_v<PresentationLayoutReconciler>);
static_assert(!std::is_copy_assignable_v<PresentationLayoutReconciler>);
static_assert(!std::is_move_constructible_v<PresentationLayoutReconciler>);
static_assert(!std::is_move_assignable_v<PresentationLayoutReconciler>);

namespace {

class FakeLayoutBackend final : public LayoutRealizer::Backend {
public:
    bool document_exists(const std::string& document_id) const override
    {
        return documents.contains(document_id);
    }

    bool load_builtin(RuntimeLayoutBuiltinDocument document, const core::MountedLayoutPolicy&,
                      LayoutCompositionGroup, core::MountedLayoutOwner, core::LayoutScalePolicy,
                      LayoutContextCompatibilityGroup) override
    {
        const std::string id = builtin_id(document);
        calls.push_back("load-builtin:" + id);
        if (fail_next_load) {
            fail_next_load = false;
            return false;
        }
        documents.insert(id);
        return true;
    }

    bool load_path(const std::string& document_id, const std::string& logical_path,
                   const core::MountedLayoutPolicy&, LayoutCompositionGroup,
                   core::MountedLayoutOwner, core::LayoutScalePolicy,
                   LayoutContextCompatibilityGroup) override
    {
        calls.push_back("load-path:" + document_id + ":" + logical_path);
        return load(document_id);
    }

    bool load_memory(const std::string& document_id, const std::string& rml,
                     const std::string& source_url,
                     const core::MountedLayoutPolicy& presentation_policy,
                     LayoutCompositionGroup composition_group, core::MountedLayoutOwner owner,
                     core::LayoutScalePolicy scale_policy,
                     LayoutContextCompatibilityGroup compatibility_group) override
    {
        calls.push_back("load-memory:" + document_id + ":" + source_url);
        loaded_rml = rml;
        loaded_presentation_policy = presentation_policy;
        loaded_composition_group = composition_group;
        loaded_owner = owner;
        loaded_scale_policy = scale_policy;
        loaded_compatibility_group = compatibility_group;
        return load(document_id);
    }

    bool apply_policy(const std::string& document_id,
                      const core::MountedLayoutPolicy& presentation_policy,
                      LayoutCompositionGroup composition_group, core::MountedLayoutOwner,
                      core::LayoutScalePolicy scale_policy,
                      LayoutContextCompatibilityGroup compatibility_group) override
    {
        calls.push_back("policy:" + document_id + ":" + std::to_string(composition_group));
        context_policies.push_back({document_id, presentation_policy, composition_group,
                                    compatibility_group, scale_policy});
        return documents.contains(document_id) && !fail_policy;
    }

    bool set_visible(const std::string& document_id, bool visible) override
    {
        calls.push_back(std::string(visible ? "show:" : "hide:") + document_id);
        return documents.contains(document_id) && !fail_visibility;
    }

    bool set_opacity(const std::string& document_id, float) override
    {
        calls.push_back("opacity:" + document_id);
        return documents.contains(document_id);
    }

    bool apply_order(const std::vector<std::string>& ordered_document_ids) override
    {
        calls.push_back("order");
        order = ordered_document_ids;
        return !fail_order && std::all_of(order.begin(), order.end(),
                                          [&](const auto& id) { return documents.contains(id); });
    }

    bool unload(const std::string& document_id) override
    {
        calls.push_back("unload:" + document_id);
        if (fail_unload_once && document_id == *fail_unload_once) {
            fail_unload_once.reset();
            return false;
        }
        documents.erase(document_id);
        return true;
    }

    void set_system_layout_documents(
        const std::vector<presentation::RuntimeSystemLayoutDocumentBinding>& bindings) override
    {
        system_layout_documents = bindings;
        ++system_layout_publication_count;
    }

    static std::string builtin_id(RuntimeLayoutBuiltinDocument document)
    {
        switch (document) {
        case RuntimeLayoutBuiltinDocument::Title:
            return "runtime_title";
        case RuntimeLayoutBuiltinDocument::GameHud:
            return "runtime_game";
        case RuntimeLayoutBuiltinDocument::PauseMenu:
            return "runtime_pause_menu";
        case RuntimeLayoutBuiltinDocument::SaveMenu:
            return "runtime_save_menu";
        case RuntimeLayoutBuiltinDocument::LoadMenu:
            return "runtime_load_menu";
        case RuntimeLayoutBuiltinDocument::SettingsMenu:
            return "runtime_settings_menu";
        case RuntimeLayoutBuiltinDocument::TextLog:
            return "runtime_text_log";
        case RuntimeLayoutBuiltinDocument::Modal:
            return "runtime_modal";
        case RuntimeLayoutBuiltinDocument::None:
            return {};
        }
        return {};
    }

    bool load(const std::string& document_id)
    {
        if (fail_next_load) {
            fail_next_load = false;
            return false;
        }
        documents.insert(document_id);
        return true;
    }

    bool fail_next_load = false;
    bool fail_policy = false;
    bool fail_visibility = false;
    bool fail_order = false;
    std::optional<std::string> fail_unload_once;
    std::unordered_set<std::string> documents;
    std::vector<std::string> calls;
    std::vector<std::string> order;
    std::string loaded_rml;
    core::MountedLayoutPolicy loaded_presentation_policy{};
    LayoutCompositionGroup loaded_composition_group = 0;
    core::MountedLayoutOwner loaded_owner = core::MountedLayoutOwner::Gameplay;
    core::LayoutScalePolicy loaded_scale_policy{};
    LayoutContextCompatibilityGroup loaded_compatibility_group = 0;
    struct ContextPolicyCall {
        std::string document_id;
        core::MountedLayoutPolicy presentation_policy{};
        LayoutCompositionGroup composition_group = 0;
        LayoutContextCompatibilityGroup compatibility_group = 0;
        core::LayoutScalePolicy scale_policy{};
    };
    std::vector<ContextPolicyCall> context_policies;
    std::vector<presentation::RuntimeSystemLayoutDocumentBinding> system_layout_documents;
    std::size_t system_layout_publication_count = 0;
};

core::CompiledProject load_project(std::string_view fixture)
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                             std::string(fixture);
    std::ifstream input(path);
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, std::string(fixture));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

core::MountedLayoutPolicy policy(std::int32_t order, core::LayoutVisibility visibility,
                                 core::PresentationPlane plane = core::PresentationPlane::GameUi)
{
    return {.plane = plane,
            .local_order = order,
            .clock = core::LayoutClockDomain::Gameplay,
            .input = core::LayoutInputMode::Normal,
            .gameplay_pause = core::GameplayPausePolicy::Continue,
            .visibility = visibility,
            .escape_dismissal = core::EscapeDismissalPolicy::Ignore,
            .entrance_operation = std::nullopt,
            .exit_operation = std::nullopt};
}

RuntimeMountedLayout
memory_layout(std::uint64_t instance, std::string id, std::int32_t order, std::string source_text,
              core::LayoutVisibility visibility = core::LayoutVisibility::Visible)
{
    auto layout = core::LayoutId::create(std::move(id));
    REQUIRE(layout);
    return {.mounted = {.instance = core::MountedLayoutInstanceId::from_number(instance),
                        .layout = std::move(layout).value(),
                        .owner = core::MountedLayoutOwner::Gameplay,
                        .policy = policy(order, visibility)},
            .source = RuntimeLayoutMemorySource{.source_url = "memory://layout.rml",
                                                .rml = std::move(source_text)},
            .composition_group = core::PresentationCompositionGroup::Interface,
            .publication_revision = core::PresentationSnapshotRevision::from_number(1)};
}

RuntimeMountedLayout project_layout(std::uint64_t instance, std::string id)
{
    auto layout = core::LayoutId::create(std::move(id));
    REQUIRE(layout);
    return {.mounted = {.instance = core::MountedLayoutInstanceId::from_number(instance),
                        .layout = std::move(layout).value(),
                        .owner = core::MountedLayoutOwner::Gameplay,
                        .policy = policy(0, core::LayoutVisibility::Visible)},
            .source = RuntimeLayoutProjectSource{},
            .composition_group = core::PresentationCompositionGroup::Interface,
            .publication_revision = core::PresentationSnapshotRevision::from_number(1)};
}

} // namespace

TEST_CASE("LayoutRealizer validates package layouts against isolated candidate assets")
{
    assets::AssetManager live_assets;
    auto live_project = std::make_shared<assets::MemoryAssetSource>();
    live_project->add("assets/fonts/current.ttf", assets::AssetBytes{1}, "current-project");
    live_assets.mount("project", live_project);

    assets::AssetManager candidate_assets;
    auto candidate_project = std::make_shared<assets::MemoryAssetSource>();
    for (const std::string_view path :
         {"assets/fonts/main.ttf", "assets/images/main.png", "assets/scripts/layout.lua",
          "assets/ui/layout.rcss", "assets/ui/layout.rml"}) {
        candidate_project->add(path, assets::AssetBytes{1}, "candidate-package");
    }
    candidate_assets.mount("project", candidate_project);

    FakeLayoutBackend backend;
    LayoutRealizer realizer(live_assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    const auto project = load_project("resources.json");

    auto live_validation = realizer.validate_project(project);
    REQUIRE_FALSE(live_validation);
    CHECK(std::any_of(live_validation.error().begin(), live_validation.error().end(),
                      [](const auto& diagnostic) {
                          return diagnostic.code == "layout_realizer.asset_unreadable";
                      }));
    CHECK(realizer.validate_project(project, candidate_assets));
}

TEST_CASE("LayoutRealizer deterministically reconciles logical mounted Layout state")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("minimal.json");
    REQUIRE(realizer.bind_session(project, *HostGeneration::from_number(7)));

    auto high = memory_layout(2, "high", 20, "<rml><body>high</body></rml>");
    auto low =
        memory_layout(1, "low", -5, "<rml><body>low</body></rml>", core::LayoutVisibility::Hidden);
    REQUIRE(realizer.reconcile_layouts({high, low}));
    REQUIRE(backend.order.size() == 2);
    CHECK(backend.order[0] == realizer.document_id(low.mounted.instance));
    CHECK(backend.order[1] == realizer.document_id(high.mounted.instance));
    CHECK(realizer.realized_count() == 2);

    const auto first_document = realizer.document_id(high.mounted.instance);
    REQUIRE(first_document);
    high.mounted.policy.local_order = -10;
    high.mounted.policy.visibility = core::LayoutVisibility::Hidden;
    REQUIRE(realizer.reconcile_layouts({low, high}));
    CHECK(realizer.document_id(high.mounted.instance) == first_document);
    CHECK(backend.order.front() == *first_document);

    REQUIRE(realizer.reconcile_layouts({}));
    CHECK(realizer.realized_count() == 0);
    CHECK(backend.documents.empty());
    REQUIRE(realizer.reconcile_layouts({}));
    CHECK(backend.documents.empty());
}

TEST_CASE("LayoutRealizer publishes active document identities for authored system Layouts")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("minimal.json");
    REQUIRE(realizer.bind_session(project, *HostGeneration::from_number(8)));

    auto game_hud = memory_layout(1, "custom-game-hud", 0,
                                  "<rml><body><div id=\"rt_mode\"></div></body></rml>");
    game_hud.system_role = core::compiled::SystemLayoutRole::GameHud;
    REQUIRE(realizer.reconcile_layouts({game_hud}));
    const auto document_id = realizer.document_id(game_hud.mounted.instance);
    REQUIRE(document_id);
    REQUIRE(backend.system_layout_documents.size() == 1);
    CHECK(backend.system_layout_documents.front().role ==
          core::compiled::SystemLayoutRole::GameHud);
    CHECK(backend.system_layout_documents.front().document_id == *document_id);

    REQUIRE(realizer.reconcile_layouts({}));
    CHECK(backend.system_layout_documents.empty());
}

TEST_CASE("LayoutRealizer replacement validates and loads before retiring the old document")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("minimal.json");
    REQUIRE(realizer.bind_session(project, *HostGeneration::from_number(3)));

    auto desired = memory_layout(1, "replaceable", 0, "<rml><body>old</body></rml>");
    REQUIRE(realizer.reconcile_layouts({desired}));
    const auto old_document = realizer.document_id(desired.mounted.instance);
    REQUIRE(old_document);
    REQUIRE(backend.document_exists(*old_document));

    desired.source = RuntimeLayoutMemorySource{.source_url = "memory://replacement.rml",
                                               .rml = "<rml><body>new</body></rml>"};
    backend.fail_next_load = true;
    auto failed = realizer.reconcile_layouts({desired});
    REQUIRE_FALSE(failed);
    CHECK(realizer.document_id(desired.mounted.instance) == old_document);
    CHECK(backend.document_exists(*old_document));
    REQUIRE_FALSE(failed.error().empty());
    CHECK(failed.error().front().message.find("operation=create") != std::string::npos);
    CHECK(failed.error().front().message.find("layout=replaceable") != std::string::npos);
    CHECK(failed.error().front().message.find("instance=1") != std::string::npos);
    CHECK(failed.error().front().message.find("source=memory:") != std::string::npos);
    CHECK(failed.error().front().message.find("owner=gameplay") != std::string::npos);
    CHECK(failed.error().front().message.find("plane=game-ui") != std::string::npos);

    REQUIRE(realizer.reconcile_layouts({desired}));
    const auto replacement = realizer.document_id(desired.mounted.instance);
    REQUIRE(replacement);
    CHECK(replacement != old_document);
    CHECK_FALSE(backend.document_exists(*old_document));
    CHECK(backend.document_exists(*replacement));
    const auto load =
        std::find_if(backend.calls.begin(), backend.calls.end(), [&](const auto& call) {
            return call.starts_with("load-memory:" + *replacement);
        });
    const auto unload =
        std::find(backend.calls.begin(), backend.calls.end(), "unload:" + *old_document);
    REQUIRE(load != backend.calls.end());
    REQUIRE(unload != backend.calls.end());
    CHECK(load < unload);
}

TEST_CASE("LayoutRealizer restores prior documents when removal fails partway")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("minimal.json");
    REQUIRE(realizer.bind_session(project, *HostGeneration::from_number(4)));

    auto first = memory_layout(1, "first", 0, "<rml><body>first</body></rml>");
    first.system_role = core::compiled::SystemLayoutRole::GameHud;
    const auto second = memory_layout(2, "second", 1, "<rml><body>second</body></rml>");
    REQUIRE(realizer.reconcile_layouts({first, second}));
    const auto publications_before_failure = backend.system_layout_publication_count;
    const auto first_document = realizer.document_id(first.mounted.instance);
    const auto second_document = realizer.document_id(second.mounted.instance);
    REQUIRE(first_document);
    REQUIRE(second_document);

    backend.fail_unload_once = *second_document;
    auto failed = realizer.reconcile_layouts({});
    REQUIRE_FALSE(failed);
    CHECK(realizer.realized_count() == 2);
    CHECK(backend.document_exists(*first_document));
    CHECK(backend.document_exists(*second_document));
    CHECK(backend.system_layout_publication_count > publications_before_failure);
    REQUIRE(backend.system_layout_documents.size() == 1);
    CHECK(backend.system_layout_documents.front().document_id == *first_document);

    REQUIRE(realizer.reconcile_layouts({}));
    CHECK(realizer.realized_count() == 0);
    CHECK(backend.documents.empty());
}

TEST_CASE("LayoutRealizer rejects stale session requests and removes idempotently")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("minimal.json");
    const auto active_generation = *HostGeneration::from_number(9);
    REQUIRE(realizer.bind_session(project, active_generation));

    const auto desired = memory_layout(4, "session-layout", 0, "<rml><body>session</body></rml>");
    RealizeLayoutRequest stale{.host_generation = *HostGeneration::from_number(8),
                               .publication_revision = desired.publication_revision,
                               .mounted = desired.mounted,
                               .composition_group = desired.composition_group,
                               .source = desired.source};
    const auto rejected = realizer.apply_layout_realization(stale);
    CHECK(rejected.disposition == LayoutRealizationDisposition::RejectedStale);
    REQUIRE_FALSE(rejected.diagnostics.empty());
    CHECK(rejected.diagnostics.front().code == "layout_realizer.stale_session_generation");
    CHECK(backend.documents.empty());

    stale.host_generation = active_generation;
    const auto created = realizer.apply_layout_realization(stale);
    CHECK(created.disposition == LayoutRealizationDisposition::Created);
    CHECK(created.affected_count == 1);
    REQUIRE(created.document_id.size() > 0);

    RemoveLayoutRealizationRequest remove{.host_generation = active_generation,
                                          .instance = desired.mounted.instance};
    const auto removed = realizer.apply_layout_realization(remove);
    CHECK(removed.disposition == LayoutRealizationDisposition::Removed);
    CHECK(removed.affected_count == 1);
    const auto removed_again = realizer.apply_layout_realization(remove);
    CHECK(removed_again.disposition == LayoutRealizationDisposition::Removed);
    CHECK(removed_again.affected_count == 0);
}

TEST_CASE("LayoutRealizer prepares immutable project Layout resources and recreates backends")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("interaction-program.json");
    const auto generation = *HostGeneration::from_number(5);
    REQUIRE(realizer.bind_session(project, generation));

    auto desired = project_layout(1, "hud-inline");
    REQUIRE(realizer.reconcile_layouts({desired}));
    CHECK(backend.loaded_rml.find("<style>") != std::string::npos);
    CHECK(backend.loaded_rml.find("<script>") != std::string::npos);
    CHECK(backend.loaded_rml.find("NovelTea Layout") != std::string::npos);
    const auto before = realizer.document_id(desired.mounted.instance);
    REQUIRE(before);

    RecreateLayoutRealizationsRequest recreate{
        .host_generation = generation,
        .backend_generation = *BackendGeneration::from_number(2),
    };
    const auto recreated = realizer.apply_layout_realization(recreate);
    CHECK(recreated.disposition == LayoutRealizationDisposition::Recreated);
    CHECK(recreated.affected_count == 1);
    const auto after = realizer.document_id(desired.mounted.instance);
    REQUIRE(after);
    CHECK(after != before);
    CHECK_FALSE(backend.document_exists(*before));
    CHECK(backend.document_exists(*after));
}

TEST_CASE("LayoutRealizer resolves scale domains and shares only contiguous compatible Layouts")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    auto project = load_project("interaction-program.json");
    REQUIRE(realizer.bind_session(project, *HostGeneration::from_number(6)));

    auto first = project_layout(1, "hud-inline");
    auto ignored = project_layout(2, "hud-inline");
    auto third = project_layout(3, "hud-inline");
    first.mounted.policy.local_order = 0;
    ignored.mounted.policy.local_order = 1;
    third.mounted.policy.local_order = 2;
    ignored.mounted.scale_overrides.ui = core::LayoutScaleInheritance::Ignore;

    const auto* immutable_definition = project.find_layout(first.mounted.layout);
    REQUIRE(immutable_definition);
    const auto immutable_scale_policy = immutable_definition->scale_policy;

    REQUIRE(realizer.reconcile_layouts({third, ignored, first}));
    REQUIRE(backend.context_policies.size() == 3);
    CHECK(backend.context_policies[0].scale_policy == core::LayoutScalePolicy{});
    CHECK(backend.context_policies[0].compatibility_group == 0);
    CHECK(backend.context_policies[1].scale_policy.ui == core::LayoutScaleInheritance::Ignore);
    CHECK(backend.context_policies[1].scale_policy.text == core::LayoutScaleInheritance::Inherit);
    CHECK(backend.context_policies[1].compatibility_group == 1);
    CHECK(backend.context_policies[2].scale_policy == core::LayoutScalePolicy{});
    CHECK(backend.context_policies[2].compatibility_group == 2);
    CHECK(backend.context_policies[0].presentation_policy == first.mounted.policy);
    CHECK(backend.context_policies[1].presentation_policy == ignored.mounted.policy);
    CHECK(backend.context_policies[2].presentation_policy == third.mounted.policy);
    CHECK(project.find_layout(first.mounted.layout)->scale_policy == immutable_scale_policy);
    CHECK(backend.context_policies[0].composition_group ==
          layout_composition_group(core::PresentationCompositionGroup::Interface));
    CHECK(backend.context_policies[1].composition_group ==
          backend.context_policies[0].composition_group);
    CHECK(backend.context_policies[2].composition_group ==
          backend.context_policies[0].composition_group);

    backend.context_policies.clear();
    REQUIRE(realizer.reconcile_layouts({third, first}));
    REQUIRE(backend.context_policies.size() == 2);
    CHECK(backend.context_policies[0].compatibility_group == 0);
    CHECK(backend.context_policies[1].compatibility_group == 0);
    CHECK(backend.context_policies[0].scale_policy == backend.context_policies[1].scale_policy);

    auto world = memory_layout(4, "world", 3, "<rml><body>world</body></rml>");
    world.mounted.policy.plane = core::PresentationPlane::WorldOverlay;
    backend.context_policies.clear();
    REQUIRE(realizer.reconcile_layouts({world}));
    REQUIRE(backend.context_policies.size() == 1);
    CHECK(backend.context_policies[0].scale_policy.ui == core::LayoutScaleInheritance::Ignore);
    CHECK(backend.context_policies[0].scale_policy.text == core::LayoutScaleInheritance::Inherit);
}

TEST_CASE("LayoutRealizer realizes authored previews in the requested scale-domain context")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    const std::string document_id(LayoutRealizer::authored_preview_document_id());
    const std::array scale_policies{
        core::LayoutScalePolicy{.ui = core::LayoutScaleInheritance::Inherit,
                                .text = core::LayoutScaleInheritance::Inherit},
        core::LayoutScalePolicy{.ui = core::LayoutScaleInheritance::Ignore,
                                .text = core::LayoutScaleInheritance::Inherit},
        core::LayoutScalePolicy{.ui = core::LayoutScaleInheritance::Inherit,
                                .text = core::LayoutScaleInheritance::Ignore},
        core::LayoutScalePolicy{.ui = core::LayoutScaleInheritance::Ignore,
                                .text = core::LayoutScaleInheritance::Ignore},
    };

    for (std::size_t index = 0; index < scale_policies.size(); ++index) {
        backend.calls.clear();
        const std::string rml = "<rml><body>authored-" + std::to_string(index) + "</body></rml>";
        REQUIRE(realizer.realize_authored_preview({.rml = rml,
                                                   .source_url = "preview://layout/current.rml",
                                                   .scale_policy = scale_policies[index]}));
        CHECK(backend.document_exists(document_id));
        CHECK(backend.loaded_rml == rml);
        CHECK(backend.loaded_scale_policy == scale_policies[index]);
        CHECK(backend.loaded_presentation_policy.plane == core::PresentationPlane::GameUi);
        CHECK(backend.loaded_composition_group ==
              layout_composition_group(core::PresentationCompositionGroup::Interface));
        CHECK(backend.loaded_owner == core::MountedLayoutOwner::Gameplay);
        CHECK(backend.loaded_compatibility_group == 0);
        if (index > 0) {
            REQUIRE_FALSE(backend.calls.empty());
            CHECK(backend.calls.front() == "unload:" + document_id);
        }
    }

    backend.calls.clear();
    const auto stable_policy = backend.loaded_scale_policy;
    auto empty = realizer.realize_authored_preview(
        {.rml = {}, .source_url = "preview://layout/empty.rml", .scale_policy = {}});
    REQUIRE_FALSE(empty);
    REQUIRE_FALSE(empty.error().empty());
    CHECK(empty.error().front().code == "layout_realizer.authored_preview_empty");
    CHECK(backend.calls.empty());
    CHECK(backend.document_exists(document_id));
    CHECK(backend.loaded_scale_policy == stable_policy);

    backend.calls.clear();
    backend.fail_unload_once = document_id;
    auto wrong_state =
        realizer.realize_authored_preview({.rml = "<rml><body>wrong-state</body></rml>",
                                           .source_url = "preview://layout/wrong-state.rml",
                                           .scale_policy = scale_policies.front()});
    REQUIRE_FALSE(wrong_state);
    REQUIRE_FALSE(wrong_state.error().empty());
    CHECK(wrong_state.error().front().code == "layout_realizer.authored_preview_unload_failed");
    CHECK(backend.document_exists(document_id));
    CHECK(backend.loaded_scale_policy == stable_policy);

    realizer.clear_authored_preview();
    CHECK_FALSE(backend.document_exists(document_id));
}

TEST_CASE("LayoutRealizer stages and atomically swaps a focused multi-document scope")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer realizer(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    const std::vector<core::editor::TypedFocusedRoomLayoutDefinition> layouts{
        {.instance_id = "hud",
         .source_kind = core::editor::TypedFocusedRoomLayoutDefinition::SourceKind::BuiltinGameHud,
         .mount_kind = core::editor::TypedFocusedRoomLayoutDefinition::MountKind::GameHud,
         .scale_policy = {},
         .order = 0,
         .visible = true},
        {.instance_id = "overlay",
         .layout_id = "overlay-layout",
         .source_kind = core::editor::TypedFocusedRoomLayoutDefinition::SourceKind::Authored,
         .layout_kind = core::editor::TypedFocusedRoomLayoutDefinition::LayoutKind::Document,
         .mount_kind = core::editor::TypedFocusedRoomLayoutDefinition::MountKind::RoomOverlay,
         .overlay_id = "overlay",
         .source_url = "project:/__noveltea_inline_layout_overlay-layout.rml",
         .rml = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::Inline,
                 .value = "<rml><head></head><body>overlay</body></rml>"},
         .rcss = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::Inline,
                  .value = {}},
         .lua = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::Inline, .value = {}},
         .scale_policy = {},
         .order = 4,
         .visible = true},
    };

    REQUIRE(realizer.stage_focused_preview(layouts));
    CHECK(backend.documents.contains("focused://candidate/1/hud/0"));
    CHECK(backend.documents.contains("focused://candidate/1/overlay/1"));
    CHECK(std::ranges::find(
              backend.calls,
              "load-path:focused://candidate/1/hud/0:system:/ui/runtime/runtime_game.rml") !=
          backend.calls.end());
    realizer.commit_focused_preview();
    CHECK(backend.order == std::vector<std::string>{"focused://candidate/1/hud/0",
                                                    "focused://candidate/1/overlay/1"});

    const std::vector<core::editor::TypedFocusedRoomLayoutDefinition> rejected_layouts{
        {.instance_id = "bad",
         .layout_id = "bad",
         .source_kind = core::editor::TypedFocusedRoomLayoutDefinition::SourceKind::Authored,
         .layout_kind = core::editor::TypedFocusedRoomLayoutDefinition::LayoutKind::Document,
         .mount_kind = core::editor::TypedFocusedRoomLayoutDefinition::MountKind::RoomOverlay,
         .overlay_id = "bad",
         .source_url = "project:/layouts/bad.rml",
         .rml = {.kind = core::editor::TypedEditorLayoutSourceComponent::Kind::LogicalAsset,
                 .value = "project-source:/layouts/bad.rml"}},
    };
    auto rejected = realizer.stage_focused_preview(rejected_layouts);
    REQUIRE_FALSE(rejected);
    CHECK(backend.documents.contains("focused://candidate/1/hud/0"));
    CHECK(backend.documents.contains("focused://candidate/1/overlay/1"));
    CHECK_FALSE(backend.documents.contains("focused://candidate/2/bad/0"));
}

TEST_CASE("FocusedPreviewPresenter preserves prior owners and commits Room candidates")
{
    assets::AssetManager assets;
    FakeLayoutBackend backend;
    LayoutRealizer layouts(assets, backend, LayoutRealizer::BorrowedBackendForTesting{});
    AssetWorldPresentationResourceResolver world(assets);
    WorldPresentationBackend world_backend(world);
    REQUIRE(world_backend.resize({1920.0f, 1080.0f}));
    test_support::MemoryScriptSource script_sources;
    script::ScriptRuntime scripts;
    REQUIRE(scripts.initialize({&script_sources}));
    std::vector<std::pair<std::string, std::string>> completions;
    std::string last_diagnostic;
    std::size_t environment_commits = 0;
    std::size_t material_applies = 0;
    std::size_t input_bindings = 0;
    RuntimeUiInputSink* bound_input_sink = nullptr;
    std::size_t legacy_preview_retirements = 0;
    bool ui_values_succeed = false;
    FocusedPreviewPresenter presenter({
        .assets = assets,
        .world_resources = world,
        .world = world_backend,
        .layouts = layouts,
        .scripts = scripts,
        .prepare_environment =
            [](const auto&) {
                return core::Result<std::function<void()>, core::Diagnostics>::success([] {});
            },
        .prepare_layout_environment =
            [&](const auto&) {
                return core::Result<std::function<void()>, core::Diagnostics>::success(
                    [&]() { ++environment_commits; });
            },
        .prepare_clear_environment =
            [&]() {
                return core::Result<std::function<void()>, core::Diagnostics>::success(
                    [&]() { ++environment_commits; });
            },
        .prepare_ui_values =
            [&](RuntimeUiGameplayValues values) {
                if (!ui_values_succeed) {
                    return core::Result<RuntimeUiGameplayValues, core::Diagnostics>::failure(
                        {{.code = "test.runtime_ui_preparation_failed",
                          .message = "Runtime UI preparation failed for the test candidate"}});
                }
                return core::Result<RuntimeUiGameplayValues, core::Diagnostics>::success(
                    std::move(values));
            },
        .commit_ui_values = [](RuntimeUiGameplayValues) {},
        .apply_materials = [&](const ShaderMaterialProject&) { ++material_applies; },
        .bind_candidate_materials = [](const ShaderMaterialProject*) {},
        .bind_input_sink =
            [&](RuntimeUiInputSink* sink) {
                bound_input_sink = sink;
                ++input_bindings;
            },
        .retire_legacy_preview = [&]() { ++legacy_preview_retirements; },
        .active_shader_variant = []() -> std::string_view { return "glsl-120"; },
        .standalone_layout_style_prefix =
            [](bool) { return std::string{"/* standalone-preview-defaults */"}; },
        .complete =
            [&](const core::editor::FocusedEditorDocumentRequest& request, std::string_view status,
                const core::Diagnostics& diagnostics) {
                completions.emplace_back(request.request_id, std::string(status));
                if (!diagnostics.empty())
                    last_diagnostic = diagnostics.front().code + ": " + diagnostics.front().message;
            },
        .report =
            [&](core::Diagnostics diagnostics) {
                if (!diagnostics.empty())
                    last_diagnostic = diagnostics.front().code + ": " + diagnostics.front().message;
            },
    });

    const nlohmann::json environment = {
        {"profile",
         {{"name", "project"},
          {"nativeResolution", {{"width", 1920}, {"height", 1080}}},
          {"scalePolicy", {{"ui", "inherit"}, {"text", "inherit"}}}}},
        {"project",
         {{"referenceResolution", {{"width", 1920}, {"height", 1080}}},
          {"worldRasterPolicy", "capped"},
          {"barColor", "#000000"},
          {"accessibility",
           {{"uiScale", {{"enabled", true}, {"minimum", 0.75}, {"maximum", 2.0}}},
            {"textScale", {{"enabled", true}, {"minimum", 0.75}, {"maximum", 2.0}}}}}}}};
    auto make_request = [](core::editor::FocusedEditorDocumentKind kind, std::string request_id,
                           nlohmann::json data, std::uint64_t sequence) {
        return core::editor::FocusedEditorDocumentRequest{
            .request_id = std::move(request_id),
            .apply_sequence = sequence,
            .project_instance_id = "project",
            .resource_stage_generation = 0,
            .kind = kind,
            .record_id = "record",
            .revision = "sha256:" + std::string(64, 'a'),
            .resource_revision = "sha256:" + std::string(64, 'b'),
            .resources = {},
            .data_json = data.dump(),
        };
    };
    const nlohmann::json layout = {
        {"schema", "noveltea.layout-preview"},
        {"schemaVersion", 1},
        {"contentMode", "layout"},
        {"layoutId", "record"},
        {"environment", environment},
        {"layoutKind", "document"},
        {"templateId", nullptr},
        {"sourceUrl", "project:/__noveltea_inline_layout_record.rml"},
        {"defaultParent", nullptr},
        {"scopedStyles", true},
        {"rml", {{"kind", "inline"}, {"text", "<rml><body/></rml>"}}},
        {"rcss", {{"kind", "inline"}, {"text", ""}}},
        {"lua", {{"kind", "inline"}, {"text", ""}}},
        {"script", {{"enabled", false}, {"namespace", nullptr}}},
        {"scalePolicy", {{"ui", "inherit"}, {"text", "inherit"}}},
        {"shaderMaterials",
         {{"schema", "noveltea.shader-materials.v2"},
          {"shaders", nlohmann::json::object()},
          {"materials", nlohmann::json::object()}}},
    };
    REQUIRE(presenter.apply(
        make_request(core::editor::FocusedEditorDocumentKind::Layout, "layout", layout, 1)));
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Layout);
    CHECK(input_bindings == 1);
    REQUIRE(bound_input_sink != nullptr);
    bool layout_event_dispatched = false;
    CHECK(bound_input_sink->dispatch_layout_event(core::MountedLayoutOwner::Gameplay, [&]() {
        layout_event_dispatched = true;
        return true;
    }));
    CHECK(layout_event_dispatched);
    CHECK_FALSE(bound_input_sink->dispatch_layout_event(core::MountedLayoutOwner::Shell,
                                                        [] { return true; }));
    CHECK(legacy_preview_retirements == 1);
    CHECK(backend.loaded_rml.find("standalone-preview-defaults") != std::string::npos);

    const nlohmann::json room = {
        {"schema", "noveltea.room-preview"},
        {"schemaVersion", 2},
        {"environment",
         {{"profile",
           {{"name", "desktop"}, {"nativeResolution", {{"width", 1280}, {"height", 720}}}}},
          {"project",
           {{"referenceResolution", {{"width", 1920}, {"height", 1080}}},
            {"worldRasterPolicy", "capped"},
            {"barColor", "#000000"},
            {"accessibility",
             {{"uiScale", {{"enabled", true}, {"minimum", 0.75}, {"maximum", 1.5}}},
              {"textScale", {{"enabled", true}, {"minimum", 0.75}, {"maximum", 1.5}}}}}}}}},
        {"room",
         {{"roomId", "foyer"},
          {"recordLabel", "Foyer"},
          {"displayName", "Foyer"},
          {"visit", {{"visitIndex", 1}, {"sourceRoomId", nullptr}, {"entryExitId", nullptr}}}}},
        {"luaAdmission",
         {{"definitions", nlohmann::json::array()},
          {"variableIds", nlohmann::json::array()},
          {"properties", nlohmann::json::array()},
          {"interactableLocationIds", nlohmann::json::array()},
          {"compositionDraftCharacterIds", nlohmann::json::array()},
          {"compositionDraftInteractableIds", nlohmann::json::array()}}},
        {"queryState",
         {{"variables", nlohmann::json::array()},
          {"properties", nlohmann::json::array()},
          {"definitions", nlohmann::json::array()},
          {"interactableLocations", nlohmann::json::array()}}},
        {"shaderMaterials",
         {{"schema", "noveltea.shader-materials.v2"},
          {"shaders", nlohmann::json::object()},
          {"materials", nlohmann::json::object()}}},
        {"world",
         {{"background",
           {{"assetId", nullptr}, {"materialId", nullptr}, {"fit", "cover"}, {"color", nullptr}}},
          {"placements", nlohmann::json::array()},
          {"persistentCharacters", nlohmann::json::array()},
          {"cast", nlohmann::json::array()},
          {"interactables", nlohmann::json::array()},
          {"props", nlohmann::json::array()},
          {"environments", nlohmann::json::array()},
          {"overlays", nlohmann::json::array()}}},
        {"layouts", nlohmann::json::array()},
        {"ui",
         {{"description", {{"markup", "plain"}, {"source", {{"kind", "resolved"}, {"text", ""}}}}},
          {"exits", nlohmann::json::array()}}},
        {"composition", nullptr},
    };
    REQUIRE(presenter.apply(
        make_request(core::editor::FocusedEditorDocumentKind::Room, "room-fail", room, 2)));
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Layout);
    CHECK(completions.back() == std::pair<std::string, std::string>{"room-fail", "failed"});

    const nlohmann::json shader = {
        {"schema", "noveltea.shader-preview"},
        {"schemaVersion", 1},
        {"contentMode", "shader"},
        {"templateId", "shader-square-v1"},
        {"activeShaderVariant", "glsl-120"},
        {"shaderMaterials",
         {{"schema", "noveltea.shader-materials.v2"},
          {"shaders", nlohmann::json::object()},
          {"materials", nlohmann::json::object()}}},
    };
    REQUIRE(presenter.apply(
        make_request(core::editor::FocusedEditorDocumentKind::Shader, "shader", shader, 3)));
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Shader);
    CHECK(environment_commits == 2);
    CHECK(input_bindings == 2);

    ui_values_succeed = true;
    REQUIRE(presenter.apply(
        make_request(core::editor::FocusedEditorDocumentKind::Room, "room-one", room, 4)));
    REQUIRE(presenter.apply(
        make_request(core::editor::FocusedEditorDocumentKind::Room, "room-two", room, 5)));
    CHECK(std::find(completions.begin(), completions.end(),
                    std::pair<std::string, std::string>{"room-one", "superseded"}) !=
          completions.end());
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Room);
    CHECK(presenter.committed_owner().apply_sequence == 5);
    CHECK(completions.back() == std::pair<std::string, std::string>{"room-two", "applied"});

    auto lua_text_room = room;
    lua_text_room["ui"]["description"]["source"] = {{"kind", "lua-expression"},
                                                    {"source", "'focused text'"}};
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                         "room-lua-text", lua_text_room, 6)));
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Room);
    CHECK(presenter.committed_owner().apply_sequence == 6);
    REQUIRE(presenter.committed_room_resolution_for_testing() != nullptr);
    CHECK(presenter.committed_room_resolution_for_testing()->view.description == "focused text");
    CHECK(completions.back() == std::pair<std::string, std::string>{"room-lua-text", "applied"});

    auto unadmitted_room = room;
    unadmitted_room["queryState"]["variables"] =
        nlohmann::json::array({{{"id", "secret"}, {"type", "integer"}, {"value", 7}}});
    unadmitted_room["ui"]["description"]["source"] = {
        {"kind", "lua-expression"},
        {"source", "tostring(assert(noveltea.variables.get('secret')))"}};
    CHECK_FALSE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                             "room-unadmitted", unadmitted_room, 7)));
    CHECK(presenter.committed_owner().apply_sequence == 6);
    CHECK(completions.back() == std::pair<std::string, std::string>{"room-unadmitted", "failed"});

    auto lua_predicate_room = room;
    lua_predicate_room["luaAdmission"]["variableIds"] = nlohmann::json::array({"count"});
    lua_predicate_room["queryState"]["variables"] =
        nlohmann::json::array({{{"id", "count"}, {"type", "integer"}, {"value", 2}}});
    lua_predicate_room["world"]["overlays"] = nlohmann::json::array(
        {{{"overlayId", "focused-overlay"},
          {"condition",
           {{"kind", "lua-predicate"}, {"source", "noveltea.variables.get('count') == 2"}}},
          {"layoutId", "focused-layout"},
          {"visible", true},
          {"order", 0}}});
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                         "room-lua-predicate", lua_predicate_room, 8)));
    presenter.update();
    CHECK(presenter.committed_owner().apply_sequence == 8);
    REQUIRE(presenter.committed_room_resolution_for_testing() != nullptr);
    REQUIRE(presenter.committed_room_resolution_for_testing()->view.overlays.size() == 1);
    CHECK(presenter.committed_room_resolution_for_testing()->view.overlays.front().layout.text() ==
          "focused-layout");

    auto composition_room = room;
    composition_room["world"]["placements"] = nlohmann::json::array(
        {{{"id", "table"},
          {"bounds", {{"x", 0.0}, {"y", 0.0}, {"width", 1.0}, {"height", 1.0}}},
          {"order", 0},
          {"label", nullptr},
          {"layoutId", nullptr}}});
    composition_room["world"]["interactables"] = nlohmann::json::array({{{"interactableId", "key"},
                                                                         {"placementId", "table"},
                                                                         {"spriteAssetId", nullptr},
                                                                         {"materialId", nullptr},
                                                                         {"enabled", true},
                                                                         {"visible", true},
                                                                         {"order", 0}}});
    composition_room["luaAdmission"]["compositionDraftInteractableIds"] =
        nlohmann::json::array({"key"});
    composition_room["composition"] = {
        {"scriptId", "compose-room"},
        {"source",
         {{"kind", "inline"},
          {"text", "room = { compose = function(context, presentation) "
                   "presentation.set_interactable_visible('key', false) end }"}}}};
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                         "room-composition", composition_room, 9)));
    presenter.update();
    CHECK(presenter.committed_owner().apply_sequence == 9);
    REQUIRE(presenter.committed_room_resolution_for_testing() != nullptr);
    REQUIRE(presenter.committed_room_resolution_for_testing()->presentation.interactables.size() ==
            1);
    CHECK_FALSE(presenter.committed_room_resolution_for_testing()
                    ->presentation.interactables.front()
                    .visible);

    const auto scripted_layout = [](bool dedicated, bool rml_lua) {
        return nlohmann::json{
            {"instanceId", "overlay-instance"},
            {"layoutId", "overlay-layout"},
            {"mount",
             {{"kind", "room-overlay"}, {"overlayId", "overlay"}, {"order", 0}, {"visible", true}}},
            {"source",
             {{"kind", "authored"},
              {"layoutKind", "document"},
              {"templateId", nullptr},
              {"sourceUrl", "project:/layouts/overlay.rml"},
              {"defaultParent", nullptr},
              {"scopedStyles", false},
              {"scriptNamespace", nullptr},
              {"rml", {{"kind", "inline"}, {"text", "<rml><head></head><body></body></rml>"}}},
              {"rcss", {{"kind", "inline"}, {"text", ""}}},
              {"lua", {{"kind", "inline"}, {"text", dedicated ? "return true" : ""}}}}},
            {"scriptEnabled", dedicated},
            {"containsDedicatedLuaSource", dedicated},
            {"containsExecutableRmlLua", rml_lua},
            {"scalePolicy", {{"ui", "inherit"}, {"text", "inherit"}}},
        };
    };
    const auto mount_overlay = [](nlohmann::json& value) {
        value["world"]["overlays"] = nlohmann::json::array({{{"overlayId", "overlay"},
                                                             {"condition", {{"kind", "always"}}},
                                                             {"layoutId", "overlay-layout"},
                                                             {"visible", true},
                                                             {"order", 0}}});
    };

    auto dedicated_layout_room = room;
    mount_overlay(dedicated_layout_room);
    dedicated_layout_room["layouts"] = nlohmann::json::array({scripted_layout(true, false)});
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                         "room-layout-lua", dedicated_layout_room, 10)));
    presenter.update();
    INFO(last_diagnostic);
    CHECK(presenter.committed_owner().apply_sequence == 10);

    auto failed_layout_room = room;
    mount_overlay(failed_layout_room);
    auto failed_layout = scripted_layout(true, false);
    failed_layout["source"]["lua"]["text"] = "error('dedicated layout failure')";
    failed_layout_room["layouts"] = nlohmann::json::array({std::move(failed_layout)});
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                         "room-layout-lua-failure", failed_layout_room, 11)));
    presenter.update();
    CHECK(presenter.committed_owner().apply_sequence == 10);
    CHECK(completions.back() ==
          std::pair<std::string, std::string>{"room-layout-lua-failure", "failed"});

    auto rml_lua_room = room;
    mount_overlay(rml_lua_room);
    rml_lua_room["layouts"] = nlohmann::json::array({scripted_layout(false, true)});
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Room,
                                         "room-rml-lua", rml_lua_room, 12)));
    presenter.update();
    CHECK(presenter.committed_owner().apply_sequence == 12);

    const auto material_applies_before_failure = material_applies;
    const auto environment_commits_before_failure = environment_commits;
    const auto input_bindings_before_failure = input_bindings;
    const auto documents_before_failure = backend.documents;
    backend.fail_next_load = true;
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Layout,
                                         "layout-apply-failure", layout, 13)));
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Room);
    CHECK(presenter.committed_owner().apply_sequence == 12);
    CHECK(material_applies == material_applies_before_failure);
    CHECK(environment_commits == environment_commits_before_failure);
    CHECK(input_bindings == input_bindings_before_failure);
    CHECK(backend.documents == documents_before_failure);
    CHECK(completions.back() ==
          std::pair<std::string, std::string>{"layout-apply-failure", "failed"});

    auto conflicting_resources = make_request(core::editor::FocusedEditorDocumentKind::Room,
                                              "room-resource-conflict", room, 14);
    conflicting_resources.resources = {
        {.resource_id = "shader:glsl",
         .source_kind = "shader-compiled-output",
         .logical_path = "project:/shaders/glsl.bin",
         .shader_variant = core::editor::EditorPreviewShaderVariant::Glsl120},
        {.resource_id = "shader:essl",
         .source_kind = "shader-compiled-output",
         .logical_path = "project:/shaders/essl.bin",
         .shader_variant = core::editor::EditorPreviewShaderVariant::Essl100},
    };
    const auto environments_before_resource_conflict =
        script::detail::ScriptRuntimeAccess::environment_count(scripts);
    CHECK_FALSE(presenter.apply(std::move(conflicting_resources)));
    CHECK(script::detail::ScriptRuntimeAccess::environment_count(scripts) ==
          environments_before_resource_conflict);
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Room);
    CHECK(presenter.committed_owner().apply_sequence == 12);
    CHECK(completions.back() ==
          std::pair<std::string, std::string>{"room-resource-conflict", "failed"});

    const auto materials_before_shader_failure = material_applies;
    const auto environments_before_shader_failure = environment_commits;
    const auto input_bindings_before_shader_failure = input_bindings;
    const auto documents_before_shader_failure = backend.documents;
    backend.fail_next_load = true;
    REQUIRE(presenter.apply(make_request(core::editor::FocusedEditorDocumentKind::Shader,
                                         "shader-apply-failure", shader, 15)));
    presenter.update();
    CHECK(presenter.committed_owner().kind == FocusedContentKind::Room);
    CHECK(presenter.committed_owner().apply_sequence == 12);
    CHECK(material_applies == materials_before_shader_failure);
    CHECK(environment_commits == environments_before_shader_failure);
    CHECK(input_bindings == input_bindings_before_shader_failure);
    CHECK(backend.documents == documents_before_shader_failure);
    CHECK(completions.back() ==
          std::pair<std::string, std::string>{"shader-apply-failure", "failed"});
}

} // namespace noveltea::host
