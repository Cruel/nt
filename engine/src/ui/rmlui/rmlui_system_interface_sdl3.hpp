#pragma once

#if defined(NOVELTEA_HAS_RMLUI)

#include <RmlUi/Core/SystemInterface.h>

namespace noveltea::ui::rmlui {

class SdlSystemInterface final : public Rml::SystemInterface {
public:
    SdlSystemInterface();
    ~SdlSystemInterface() override;

    double GetElapsedTime() override;
    void SetMouseCursor(const Rml::String& cursor_name) override;
    void SetClipboardText(const Rml::String& text) override;
    void GetClipboardText(Rml::String& text) override;
    bool LogMessage(Rml::Log::Type type, const Rml::String& message) override;

private:
    uint64_t m_start = 0;
    double m_frequency = 1.0;
};

} // namespace noveltea::ui::rmlui

#endif
