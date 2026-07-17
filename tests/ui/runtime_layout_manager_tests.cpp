#include "noveltea/runtime_layout_manager.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <string>
#include <vector>

namespace {

class FakeDocumentHost final : public noveltea::RuntimeLayoutDocumentHost {
public:
    bool load_builtin(noveltea::RuntimeLayoutBuiltinDocument,
                      const noveltea::core::MountedLayoutPolicy&) override
    {
        return load_succeeds;
    }
    bool load_document(const std::string&, const std::string&, bool,
                       const noveltea::core::MountedLayoutPolicy&) override
    {
        return load_succeeds;
    }
    bool apply_layout_state(
        const std::vector<noveltea::RuntimeLayoutDocumentState>& ordered_state) override
    {
        if (!realization_succeeds)
            return false;
        last_state = ordered_state;
        return true;
    }
    bool unload_document(const std::string& id) override
    {
        calls.push_back("unload:" + id);
        return true;
    }

    bool load_succeeds = true;
    bool realization_succeeds = true;
    std::vector<std::string> calls;
    std::vector<noveltea::RuntimeLayoutDocumentState> last_state;
};

noveltea::RuntimeLayoutMountRequest custom_request(std::string layout, std::int32_t order)
{
    noveltea::RuntimeLayoutMountRequest request;
    request.layout_id = std::move(layout);
    request.document_id = "document_" + request.layout_id;
    request.asset_path = "project:/layouts/fixture.rml";
    request.policy.local_order = order;
    return request;
}

} // namespace

TEST_CASE("mounted Layout helpers use canonical typed defaults")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager;
    manager.bind_document_host(&host);

    const auto title = manager.mount_builtin_title();
    const auto hud = manager.mount_builtin_game_hud(false);
    const auto pause = manager.mount_builtin_pause_menu();
    REQUIRE(title);
    REQUIRE(hud);
    REQUIRE(pause);

    const auto* title_mount = manager.find(title.value());
    REQUIRE(title_mount);
    CHECK(title_mount->mounted.owner == noveltea::core::MountedLayoutOwner::Shell);
    CHECK(title_mount->mounted.policy.plane == noveltea::core::PresentationPlane::MenuOverlay);
    CHECK(title_mount->mounted.policy.clock ==
          noveltea::core::LayoutClockDomain::UnscaledPresentation);
    CHECK(title_mount->mounted.policy.input == noveltea::core::LayoutInputMode::Modal);
    CHECK(title_mount->mounted.policy.gameplay_pause ==
          noveltea::core::GameplayPausePolicy::PauseWhileVisible);
    CHECK(title_mount->mounted.policy.escape_dismissal ==
          noveltea::core::EscapeDismissalPolicy::Ignore);

    const auto* hud_mount = manager.find(hud.value());
    REQUIRE(hud_mount);
    CHECK(hud_mount->mounted.owner == noveltea::core::MountedLayoutOwner::Gameplay);
    CHECK(hud_mount->mounted.policy.visibility == noveltea::core::LayoutVisibility::Hidden);

    const auto* pause_mount = manager.find(pause.value());
    REQUIRE(pause_mount);
    CHECK(pause_mount->mounted.policy.escape_dismissal ==
          noveltea::core::EscapeDismissalPolicy::Dismiss);
    REQUIRE(host.last_state.size() == 3);
    CHECK(std::count_if(host.last_state.begin(), host.last_state.end(), [](const auto& state) {
              return state.owner == noveltea::core::MountedLayoutOwner::Shell;
          }) == 2);
    CHECK(std::count_if(host.last_state.begin(), host.last_state.end(), [](const auto& state) {
              return state.owner == noveltea::core::MountedLayoutOwner::Gameplay;
          }) == 1);
}

TEST_CASE("built-in realization preserves an explicitly resolved system Layout policy")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager;
    manager.bind_document_host(&host);

    noveltea::RuntimeLayoutMountRequest request;
    request.layout_id = "system-save-menu";
    request.document_id = "runtime_save_menu";
    request.builtin_document = noveltea::RuntimeLayoutBuiltinDocument::SaveMenu;
    request.owner = noveltea::core::MountedLayoutOwner::Shell;
    request.policy = {.plane = noveltea::core::PresentationPlane::Modal,
                      .local_order = 77,
                      .clock = noveltea::core::LayoutClockDomain::UnscaledPresentation,
                      .input = noveltea::core::LayoutInputMode::BlockGameplay,
                      .gameplay_pause = noveltea::core::GameplayPausePolicy::Continue,
                      .visibility = noveltea::core::LayoutVisibility::Hidden,
                      .escape_dismissal = noveltea::core::EscapeDismissalPolicy::Dismiss,
                      .entrance_operation = std::nullopt,
                      .exit_operation = std::nullopt};

    const auto mounted = manager.mount(std::move(request));
    REQUIRE(mounted);
    const auto* record = manager.find(mounted.value());
    REQUIRE(record);
    CHECK(record->mounted.policy.plane == noveltea::core::PresentationPlane::Modal);
    CHECK(record->mounted.policy.local_order == 77);
    CHECK(record->mounted.policy.input == noveltea::core::LayoutInputMode::BlockGameplay);
    CHECK(record->mounted.policy.gameplay_pause == noveltea::core::GameplayPausePolicy::Continue);
    CHECK(record->mounted.policy.visibility == noveltea::core::LayoutVisibility::Hidden);
}

TEST_CASE("mounted Layout mount failures are atomic and IDs never reuse")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager(2);
    manager.bind_document_host(&host);

    host.load_succeeds = false;
    CHECK_FALSE(manager.mount(custom_request("failed", 0)));
    CHECK(manager.mounted_layouts().empty());

    host.load_succeeds = true;
    const auto first = manager.mount(custom_request("first", 0));
    REQUIRE(first);
    CHECK(first.value().number() == 1);
    host.realization_succeeds = false;
    CHECK_FALSE(manager.mount(custom_request("realization-failed", 0)));
    CHECK(manager.mounted_layouts().size() == 1);
    host.realization_succeeds = true;
    auto duplicate = custom_request("first-copy", 0);
    duplicate.document_id = "document_first";
    const auto duplicate_result = manager.mount(std::move(duplicate));
    CHECK_FALSE(duplicate_result);
    CHECK(manager.mounted_layouts().size() == 1);
}

TEST_CASE("mounted Layout policies replace atomically and determine stable ordering")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager;
    manager.bind_document_host(&host);

    auto high_request = custom_request("high", 8);
    auto low_request = custom_request("low", -3);
    auto modal_request = custom_request("modal", -100);
    modal_request.owner = noveltea::core::MountedLayoutOwner::Shell;
    modal_request.policy.plane = noveltea::core::PresentationPlane::Modal;
    const auto high = manager.mount(std::move(high_request));
    const auto low = manager.mount(std::move(low_request));
    const auto modal = manager.mount(std::move(modal_request));
    REQUIRE(high);
    REQUIRE(low);
    REQUIRE(modal);
    CHECK(manager.mounted_layouts()[0].mounted.instance == low.value());
    CHECK(manager.mounted_layouts()[1].mounted.instance == high.value());
    CHECK(manager.mounted_layouts()[2].mounted.instance == modal.value());

    auto replacement = manager.find(high.value())->mounted.policy;
    replacement.visibility = noveltea::core::LayoutVisibility::Hidden;
    replacement.local_order = -10;
    REQUIRE(manager.replace_policy(high.value(), replacement));
    CHECK(manager.find(high.value())->mounted.instance == high.value());
    CHECK(manager.find(high.value())->mounted.policy == replacement);

    host.realization_succeeds = false;
    auto failed = replacement;
    failed.visibility = noveltea::core::LayoutVisibility::Visible;
    failed.local_order = 100;
    CHECK_FALSE(manager.replace_policy(high.value(), failed));
    CHECK(manager.find(high.value())->mounted.policy == replacement);
    CHECK(manager.mounted_layouts()[0].mounted.instance == high.value());
}

TEST_CASE("mounted Layout reset retires identities")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager(2);
    manager.bind_document_host(&host);
    const auto first = manager.mount(custom_request("first", 0));
    REQUIRE(first);
    REQUIRE(manager.unmount(first.value()));
    const auto second = manager.mount(custom_request("second", 0));
    REQUIRE(second);
    CHECK(second.value().number() == 2);
    manager.reset();
    CHECK(manager.mounted_layouts().empty());
    const auto exhausted = manager.mount(custom_request("third", 0));
    CHECK_FALSE(exhausted);
    REQUIRE(exhausted.error().size() == 1);
    CHECK(exhausted.error()[0].code == "layout.instance_exhausted");
}

TEST_CASE("visible mounted Layout input policy is deterministic")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager;
    manager.bind_document_host(&host);

    auto none = custom_request("none", 100);
    none.policy.input = noveltea::core::LayoutInputMode::None;
    auto normal = custom_request("normal", 1);
    auto blocking = custom_request("blocking", -10);
    blocking.policy.input = noveltea::core::LayoutInputMode::BlockGameplay;
    auto modal = custom_request("modal", -100);
    modal.policy.input = noveltea::core::LayoutInputMode::Modal;
    modal.policy.visibility = noveltea::core::LayoutVisibility::Hidden;
    const auto none_id = manager.mount(std::move(none));
    const auto normal_id = manager.mount(std::move(normal));
    const auto blocking_id = manager.mount(std::move(blocking));
    const auto modal_id = manager.mount(std::move(modal));
    REQUIRE(none_id);
    REQUIRE(normal_id);
    REQUIRE(blocking_id);
    REQUIRE(modal_id);

    auto evaluation = manager.evaluate_input_policy();
    CHECK(evaluation.gameplay == noveltea::GameplayInputDisposition::BlockedByLayout);
    CHECK(evaluation.governing_instance == blocking_id.value());
    CHECK(evaluation.governing_mode == noveltea::core::LayoutInputMode::BlockGameplay);

    auto top_blocking = custom_request("top-blocking", 20);
    top_blocking.policy.input = noveltea::core::LayoutInputMode::BlockGameplay;
    const auto top_blocking_id = manager.mount(std::move(top_blocking));
    REQUIRE(top_blocking_id);
    evaluation = manager.evaluate_input_policy();
    CHECK(evaluation.governing_instance == top_blocking_id.value());

    REQUIRE(manager.show(modal_id.value()));
    evaluation = manager.evaluate_input_policy();
    CHECK(evaluation.governing_instance == modal_id.value());
    CHECK(evaluation.governing_mode == noveltea::core::LayoutInputMode::Modal);

    REQUIRE(manager.hide(modal_id.value()));
    REQUIRE(manager.hide(blocking_id.value()));
    REQUIRE(manager.hide(top_blocking_id.value()));
    evaluation = manager.evaluate_input_policy();
    CHECK(evaluation.gameplay == noveltea::GameplayInputDisposition::Eligible);
    CHECK(evaluation.governing_instance == normal_id.value());
}

TEST_CASE("Escape dismissal respects topmost ordering and modal shielding")
{
    FakeDocumentHost host;
    noveltea::RuntimeLayoutManager manager;
    manager.bind_document_host(&host);

    auto lower = custom_request("lower", 0);
    lower.owner = noveltea::core::MountedLayoutOwner::Gameplay;
    lower.policy.escape_dismissal = noveltea::core::EscapeDismissalPolicy::Dismiss;
    auto upper = custom_request("upper", 1);
    upper.owner = noveltea::core::MountedLayoutOwner::Shell;
    upper.policy.escape_dismissal = noveltea::core::EscapeDismissalPolicy::Dismiss;
    const auto lower_id = manager.mount(std::move(lower));
    const auto upper_id = manager.mount(std::move(upper));
    REQUIRE(lower_id);
    REQUIRE(upper_id);

    const auto target = manager.escape_dismissal_target();
    REQUIRE(target);
    CHECK(target->instance == upper_id.value());
    CHECK(target->owner == noveltea::core::MountedLayoutOwner::Shell);
    REQUIRE(manager.dismiss_escape_target(*target));
    CHECK(manager.find(upper_id.value()) == nullptr);

    auto shield = custom_request("shield", 50);
    shield.policy.input = noveltea::core::LayoutInputMode::Modal;
    shield.policy.escape_dismissal = noveltea::core::EscapeDismissalPolicy::Ignore;
    REQUIRE(manager.mount(std::move(shield)));
    CHECK_FALSE(manager.escape_dismissal_target());
    CHECK(manager.find(lower_id.value()) != nullptr);
}
