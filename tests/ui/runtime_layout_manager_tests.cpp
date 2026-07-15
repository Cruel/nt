#include "noveltea/runtime_layout_manager.hpp"

#include <catch2/catch_test_macros.hpp>

#include <string>
#include <vector>

namespace {

class FakeDocumentHost final : public noveltea::RuntimeLayoutDocumentHost {
public:
    bool load_builtin(noveltea::RuntimeLayoutBuiltinDocument) override { return load_succeeds; }
    bool load_document(const std::string&, const std::string&, bool) override
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
