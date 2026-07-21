#include "noveltea/presentation/runtime_system_layouts.hpp"

#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <optional>
#include <type_traits>
#include <utility>
#include <vector>

namespace {

using namespace noveltea;
using namespace noveltea::presentation;

struct FakeSystemLayoutHost final : RuntimeSystemLayoutHost {
    struct Mounted {
        core::compiled::SystemLayoutRole role;
        core::MountedLayoutPolicy policy;
        core::MountedLayoutInstanceId instance;
    };

    core::Result<core::MountedLayoutInstanceId, core::Diagnostics>
    mount_system_layout(core::compiled::SystemLayoutRole role,
                        core::MountedLayoutPolicy policy) override
    {
        const auto instance = core::MountedLayoutInstanceId::from_number(next_instance++);
        mounted.push_back({role, policy, instance});
        return core::Result<core::MountedLayoutInstanceId, core::Diagnostics>::success(instance);
    }

    core::Result<void, core::Diagnostics>
    set_system_layout_visible(core::MountedLayoutInstanceId instance, bool visible) override
    {
        visibility_changes.emplace_back(instance, visible);
        const auto found = std::find_if(mounted.begin(), mounted.end(), [&](const auto& item) {
            return item.instance == instance;
        });
        if (found != mounted.end())
            found->policy.visibility =
                visible ? core::LayoutVisibility::Visible : core::LayoutVisibility::Hidden;
        return core::Result<void, core::Diagnostics>::success();
    }

    core::Result<void, core::Diagnostics>
    unmount_system_layout(core::MountedLayoutInstanceId instance) override
    {
        unmounted.push_back(instance);
        return core::Result<void, core::Diagnostics>::success();
    }

    bool dispatch_shell_runtime_input(core::RuntimeInputMessage input) override
    {
        inputs.push_back(std::move(input));
        return accept_inputs;
    }

    core::Result<void, core::Diagnostics> set_runtime_ui_scale(double scale) override
    {
        auto changed = settings.with_ui_scale(scale, accessibility);
        if (!changed)
            return core::Result<void, core::Diagnostics>::failure(std::move(changed).error());
        settings = *changed.value_if();
        return core::Result<void, core::Diagnostics>::success();
    }

    core::Result<void, core::Diagnostics> set_runtime_text_scale(double scale) override
    {
        auto changed = settings.with_text_scale(scale, accessibility);
        if (!changed)
            return core::Result<void, core::Diagnostics>::failure(std::move(changed).error());
        settings = *changed.value_if();
        return core::Result<void, core::Diagnostics>::success();
    }

    core::RuntimeShellViewState
    build_runtime_shell_view(core::RuntimeShellScreen screen,
                             const std::optional<core::RuntimeShellConfirmation>& confirmation,
                             bool game_active) override
    {
        auto view = core::RuntimeShellViewState{};
        view.screen = screen;
        view.settings = settings;
        view.confirmation = confirmation;
        view.game_active = game_active;
        return view;
    }

    void publish_runtime_shell_view(core::RuntimeShellViewState view) override
    {
        publications.push_back(std::move(view));
    }

    void request_shell_quit() override { quit_requested = true; }

    template<typename T> bool dispatched() const
    {
        return std::any_of(inputs.begin(), inputs.end(),
                           [](const auto& input) { return std::holds_alternative<T>(input); });
    }

    std::uint64_t next_instance = 1;
    bool accept_inputs = true;
    bool quit_requested = false;
    core::compiled::AccessibilitySettings accessibility{
        .ui_scale = {.enabled = true, .minimum = 0.8, .maximum = 1.5},
        .text_scale = {.enabled = true, .minimum = 1.0, .maximum = 2.0},
    };
    core::RuntimeUserSettings settings = core::RuntimeUserSettings::defaults();
    std::vector<Mounted> mounted;
    std::vector<std::pair<core::MountedLayoutInstanceId, bool>> visibility_changes;
    std::vector<core::MountedLayoutInstanceId> unmounted;
    std::vector<core::RuntimeInputMessage> inputs;
    std::vector<core::RuntimeShellViewState> publications;
};

const FakeSystemLayoutHost::Mounted* mounted_role(const FakeSystemLayoutHost& host,
                                                  core::compiled::SystemLayoutRole role)
{
    const auto found = std::find_if(host.mounted.begin(), host.mounted.end(),
                                    [&](const auto& item) { return item.role == role; });
    return found == host.mounted.end() ? nullptr : &*found;
}

} // namespace

TEST_CASE("system Layout policies derive shell pause, input, and clock behavior")
{
    const auto pause = runtime_system_layout_policy(core::compiled::SystemLayoutRole::PauseMenu);
    CHECK(pause.plane == core::PresentationPlane::MenuOverlay);
    CHECK(pause.clock == core::LayoutClockDomain::UnscaledPresentation);
    CHECK(pause.input == core::LayoutInputMode::Modal);
    CHECK(pause.gameplay_pause == core::GameplayPausePolicy::PauseWhileVisible);

    const auto log = runtime_system_layout_policy(core::compiled::SystemLayoutRole::TextLog);
    CHECK(log.input == core::LayoutInputMode::BlockGameplay);
    CHECK(log.gameplay_pause == core::GameplayPausePolicy::Continue);

    const auto debug = runtime_system_layout_policy(core::compiled::SystemLayoutRole::DebugOverlay);
    CHECK(debug.plane == core::PresentationPlane::Debug);
    CHECK(debug.gameplay_pause == core::GameplayPausePolicy::Continue);
}

TEST_CASE("system Layout workflow supports nested pause settings confirmation and title reset")
{
    FakeSystemLayoutHost host;
    RuntimeSystemLayouts layouts(host);
    REQUIRE(layouts.initialize(true));
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Title);
    CHECK_FALSE(layouts.game_active());

    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::StartGameShellCommand{}}));
    CHECK(host.dispatched<core::StartRuntimeInput>());
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::None);
    CHECK(layouts.game_active());

    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenPauseShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenSettingsShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::RequestReturnToTitleShellCommand{}}));
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Confirmation);
    const auto* pause = mounted_role(host, core::compiled::SystemLayoutRole::PauseMenu);
    const auto* settings = mounted_role(host, core::compiled::SystemLayoutRole::SettingsMenu);
    const auto* modal = mounted_role(host, core::compiled::SystemLayoutRole::Modal);
    REQUIRE(pause);
    REQUIRE(settings);
    REQUIRE(modal);
    CHECK(pause->policy.gameplay_pause == core::GameplayPausePolicy::PauseWhileVisible);
    CHECK(settings->policy.input == core::LayoutInputMode::Modal);
    CHECK(modal->policy.plane == core::PresentationPlane::Modal);

    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::CancelShellCommand{}}));
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Settings);
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::RequestReturnToTitleShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::ConfirmShellCommand{}}));
    CHECK(host.dispatched<core::ResetRuntimeInput>());
    CHECK(host.dispatched<core::StopRuntimeInput>());
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Title);
    CHECK_FALSE(layouts.game_active());
}

TEST_CASE("system Layout workflow routes typed save load and settings commands")
{
    FakeSystemLayoutHost host;
    RuntimeSystemLayouts layouts(host);
    REQUIRE(layouts.initialize(false));

    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenSaveShellCommand{}}));
    REQUIRE(layouts.dispatch(
        core::RuntimeShellCommand{core::SaveShellSlotCommand{core::TypedSaveSlotId::manual(2)}}));
    CHECK(host.dispatched<core::SaveRuntimeInput>());

    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::CloseShellScreenCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenLoadShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{
        core::RequestLoadShellSlotCommand{core::TypedSaveSlotId::manual(3)}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::ConfirmShellCommand{}}));
    CHECK(host.dispatched<core::LoadRuntimeInput>());

    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenSettingsShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::SetRuntimeUiScaleShellCommand{1.2}}));
    REQUIRE(
        layouts.dispatch(core::RuntimeShellCommand{core::SetRuntimeTextScaleShellCommand{1.25}}));
    CHECK(host.settings.ui_scale() == 1.2);
    CHECK(host.settings.text_scale() == 1.25);

    const auto rejected =
        layouts.dispatch(core::RuntimeShellCommand{core::SetRuntimeUiScaleShellCommand{2.0}});
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().front().code == "runtime_user_settings.ui_scale_out_of_range");
}

TEST_CASE("title load starts gameplay and escape uses shell-owned workflows")
{
    FakeSystemLayoutHost host;
    RuntimeSystemLayouts layouts(host);
    REQUIRE(layouts.initialize(true));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenLoadShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{
        core::RequestLoadShellSlotCommand{core::TypedSaveSlotId::autosave()}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::ConfirmShellCommand{}}));
    CHECK(host.dispatched<core::LoadRuntimeInput>());
    CHECK(host.dispatched<core::StartRuntimeInput>());
    CHECK(layouts.game_active());

    CHECK(layouts.handle_escape());
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Pause);
    CHECK(layouts.handle_escape());
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::None);
}

TEST_CASE("system Layout reset clears shell stack and supports fresh project initialization")
{
    FakeSystemLayoutHost host;
    RuntimeSystemLayouts layouts(host);
    REQUIRE(layouts.initialize(false));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenPauseShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::OpenSettingsShellCommand{}}));
    REQUIRE(layouts.dispatch(core::RuntimeShellCommand{core::RequestQuitShellCommand{}}));
    REQUIRE(layouts.current_screen() == core::RuntimeShellScreen::Confirmation);

    const auto mounted_before_reset = host.mounted;
    layouts.reset();

    CHECK_FALSE(layouts.game_active());
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Title);
    for (const auto& mounted : mounted_before_reset) {
        CHECK(std::find(host.unmounted.begin(), host.unmounted.end(), mounted.instance) !=
              host.unmounted.end());
    }

    const auto mounts_before_reload = host.mounted.size();
    REQUIRE(layouts.initialize(true));
    CHECK_FALSE(layouts.game_active());
    CHECK(layouts.current_screen() == core::RuntimeShellScreen::Title);
    CHECK(host.mounted.size() == mounts_before_reload + 2);
}
