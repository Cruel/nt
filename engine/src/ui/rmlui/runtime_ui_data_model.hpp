#pragma once

#include "noveltea/core/runtime_shell_contracts.hpp"
#include "noveltea/runtime_ui_contracts.hpp"

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace Rml {
class Context;
class Event;
} // namespace Rml

namespace noveltea::ui::rmlui {

class RuntimeUiActionGateway;

class RuntimeUiDataModel final {
public:
    using PresentationParentResolver =
        std::function<std::optional<core::LayoutPresentationParent>(Rml::Event&)>;

    explicit RuntimeUiDataModel(RuntimeUiActionGateway& action_gateway,
                                PresentationParentResolver presentation_parent_resolver = {});
    ~RuntimeUiDataModel();

    RuntimeUiDataModel(const RuntimeUiDataModel&) = delete;
    RuntimeUiDataModel& operator=(const RuntimeUiDataModel&) = delete;

    [[nodiscard]] bool attach_context(Rml::Context& context);
    void detach_context(Rml::Context& context);
    void detach_all();

    void set_project(std::string title, std::string subtitle, std::string start_label);
    void set_gameplay(const RuntimeUiGameplayValues& values, const std::string& typed_notification);
    void clear_gameplay();
    void set_gameplay_notification(const std::string& typed_notification,
                                   const core::TypedRuntimeUIViewState* view);
    void set_shell(const core::RuntimeShellViewState& view,
                   const std::vector<std::string>& thumbnail_urls);
    void clear_shell();

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::ui::rmlui
