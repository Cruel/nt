#pragma once

#if defined(NOVELTEA_HAS_RMLUI)

#include <RmlUi/Core/Input.h>
#include <SDL3/SDL_events.h>

struct SDL_Window;
namespace Rml { class Context; }

namespace noveltea::ui::rmlui {

Rml::Input::KeyIdentifier convert_sdl_key(int sdl_key);
int get_key_modifier_state();
bool process_sdl_event(Rml::Context& context, SDL_Window* window, const SDL_Event& event);

} // namespace noveltea::ui::rmlui

#endif
