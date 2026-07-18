#include "host/layout_realizer.hpp"
#include "host/presentation_layout_reconciler.hpp"

#include "noveltea/core/compiled_project_codec.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <fstream>
#include <iterator>
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
                      LayoutCompositionGroup, core::MountedLayoutOwner) override
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
                   core::MountedLayoutOwner) override
    {
        calls.push_back("load-path:" + document_id + ":" + logical_path);
        return load(document_id);
    }

    bool load_memory(const std::string& document_id, const std::string& rml,
                     const std::string& source_url, const core::MountedLayoutPolicy&,
                     LayoutCompositionGroup, core::MountedLayoutOwner) override
    {
        calls.push_back("load-memory:" + document_id + ":" + source_url);
        loaded_rml = rml;
        return load(document_id);
    }

    bool apply_policy(const std::string& document_id, const core::MountedLayoutPolicy&,
                      LayoutCompositionGroup composition_group, core::MountedLayoutOwner) override
    {
        calls.push_back("policy:" + document_id + ":" + std::to_string(composition_group));
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

    const auto first = memory_layout(1, "first", 0, "<rml><body>first</body></rml>");
    const auto second = memory_layout(2, "second", 1, "<rml><body>second</body></rml>");
    REQUIRE(realizer.reconcile_layouts({first, second}));
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

} // namespace noveltea::host
