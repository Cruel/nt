#include "ui/rmlui/rmlui_input_sdl3.hpp"

#if defined(NOVELTEA_HAS_RMLUI)

#include <RmlUi/Core/Context.h>
#include <SDL3/SDL.h>

namespace noveltea::ui::rmlui {

Rml::Input::KeyIdentifier convert_sdl_key(int key)
{
    using namespace Rml::Input;
    switch (key) {
    case SDLK_UNKNOWN: return KI_UNKNOWN;
    case SDLK_BACKSPACE: return KI_BACK;
    case SDLK_TAB: return KI_TAB;
    case SDLK_CLEAR: return KI_CLEAR;
    case SDLK_RETURN: return KI_RETURN;
    case SDLK_PAUSE: return KI_PAUSE;
    case SDLK_ESCAPE: return KI_ESCAPE;
    case SDLK_SPACE: return KI_SPACE;
    case SDLK_EXCLAIM: return KI_OEM_1;
    case SDLK_DBLAPOSTROPHE: return KI_OEM_7;
    case SDLK_HASH: return KI_OEM_3;
    case SDLK_DOLLAR: return KI_4;
    case SDLK_AMPERSAND: return KI_7;
    case SDLK_APOSTROPHE: return KI_OEM_7;
    case SDLK_LEFTPAREN: return KI_9;
    case SDLK_RIGHTPAREN: return KI_0;
    case SDLK_ASTERISK: return KI_MULTIPLY;
    case SDLK_PLUS: return KI_ADD;
    case SDLK_COMMA: return KI_OEM_COMMA;
    case SDLK_MINUS: return KI_OEM_MINUS;
    case SDLK_PERIOD: return KI_OEM_PERIOD;
    case SDLK_SLASH: return KI_OEM_2;
    case SDLK_0: return KI_0;
    case SDLK_1: return KI_1;
    case SDLK_2: return KI_2;
    case SDLK_3: return KI_3;
    case SDLK_4: return KI_4;
    case SDLK_5: return KI_5;
    case SDLK_6: return KI_6;
    case SDLK_7: return KI_7;
    case SDLK_8: return KI_8;
    case SDLK_9: return KI_9;
    case SDLK_COLON: return KI_OEM_1;
    case SDLK_SEMICOLON: return KI_OEM_1;
    case SDLK_LESS: return KI_OEM_COMMA;
    case SDLK_EQUALS: return KI_OEM_PLUS;
    case SDLK_GREATER: return KI_OEM_PERIOD;
    case SDLK_QUESTION: return KI_OEM_2;
    case SDLK_AT: return KI_2;
    case SDLK_LEFTBRACKET: return KI_OEM_4;
    case SDLK_BACKSLASH: return KI_OEM_5;
    case SDLK_RIGHTBRACKET: return KI_OEM_6;
    case SDLK_CARET: return KI_6;
    case SDLK_UNDERSCORE: return KI_OEM_MINUS;
    case SDLK_GRAVE: return KI_OEM_3;
    case SDLK_A: return KI_A;
    case SDLK_B: return KI_B;
    case SDLK_C: return KI_C;
    case SDLK_D: return KI_D;
    case SDLK_E: return KI_E;
    case SDLK_F: return KI_F;
    case SDLK_G: return KI_G;
    case SDLK_H: return KI_H;
    case SDLK_I: return KI_I;
    case SDLK_J: return KI_J;
    case SDLK_K: return KI_K;
    case SDLK_L: return KI_L;
    case SDLK_M: return KI_M;
    case SDLK_N: return KI_N;
    case SDLK_O: return KI_O;
    case SDLK_P: return KI_P;
    case SDLK_Q: return KI_Q;
    case SDLK_R: return KI_R;
    case SDLK_S: return KI_S;
    case SDLK_T: return KI_T;
    case SDLK_U: return KI_U;
    case SDLK_V: return KI_V;
    case SDLK_W: return KI_W;
    case SDLK_X: return KI_X;
    case SDLK_Y: return KI_Y;
    case SDLK_Z: return KI_Z;
    case SDLK_DELETE: return KI_DELETE;
    case SDLK_KP_0: return KI_NUMPAD0;
    case SDLK_KP_1: return KI_NUMPAD1;
    case SDLK_KP_2: return KI_NUMPAD2;
    case SDLK_KP_3: return KI_NUMPAD3;
    case SDLK_KP_4: return KI_NUMPAD4;
    case SDLK_KP_5: return KI_NUMPAD5;
    case SDLK_KP_6: return KI_NUMPAD6;
    case SDLK_KP_7: return KI_NUMPAD7;
    case SDLK_KP_8: return KI_NUMPAD8;
    case SDLK_KP_9: return KI_NUMPAD9;
    case SDLK_KP_PERIOD: return KI_DECIMAL;
    case SDLK_KP_DIVIDE: return KI_DIVIDE;
    case SDLK_KP_MULTIPLY: return KI_MULTIPLY;
    case SDLK_KP_MINUS: return KI_SUBTRACT;
    case SDLK_KP_PLUS: return KI_ADD;
    case SDLK_KP_ENTER: return KI_NUMPADENTER;
    case SDLK_UP: return KI_UP;
    case SDLK_DOWN: return KI_DOWN;
    case SDLK_RIGHT: return KI_RIGHT;
    case SDLK_LEFT: return KI_LEFT;
    case SDLK_INSERT: return KI_INSERT;
    case SDLK_HOME: return KI_HOME;
    case SDLK_END: return KI_END;
    case SDLK_PAGEUP: return KI_PRIOR;
    case SDLK_PAGEDOWN: return KI_NEXT;
    case SDLK_F1: return KI_F1;
    case SDLK_F2: return KI_F2;
    case SDLK_F3: return KI_F3;
    case SDLK_F4: return KI_F4;
    case SDLK_F5: return KI_F5;
    case SDLK_F6: return KI_F6;
    case SDLK_F7: return KI_F7;
    case SDLK_F8: return KI_F8;
    case SDLK_F9: return KI_F9;
    case SDLK_F10: return KI_F10;
    case SDLK_F11: return KI_F11;
    case SDLK_F12: return KI_F12;
    case SDLK_F13: return KI_F13;
    case SDLK_F14: return KI_F14;
    case SDLK_F15: return KI_F15;
    case SDLK_NUMLOCKCLEAR: return KI_NUMLOCK;
    case SDLK_SCROLLLOCK: return KI_SCROLL;
    case SDLK_CAPSLOCK: return KI_CAPITAL;
    case SDLK_LSHIFT: return KI_LSHIFT;
    case SDLK_RSHIFT: return KI_RSHIFT;
    case SDLK_LCTRL: return KI_LCONTROL;
    case SDLK_RCTRL: return KI_RCONTROL;
    case SDLK_LALT: return KI_LMENU;
    case SDLK_RALT: return KI_RMENU;
    case SDLK_LGUI: return KI_LMETA;
    case SDLK_RGUI: return KI_RMETA;
    default: return KI_UNKNOWN;
    }
}

int get_key_modifier_state()
{
    const SDL_Keymod mods = SDL_GetModState();
    int result = 0;
    if (mods & SDL_KMOD_CTRL) result |= Rml::Input::KM_CTRL;
    if (mods & SDL_KMOD_SHIFT) result |= Rml::Input::KM_SHIFT;
    if (mods & SDL_KMOD_ALT) result |= Rml::Input::KM_ALT;
    if (mods & SDL_KMOD_GUI) result |= Rml::Input::KM_META;
    if (mods & SDL_KMOD_NUM) result |= Rml::Input::KM_NUMLOCK;
    if (mods & SDL_KMOD_CAPS) result |= Rml::Input::KM_CAPSLOCK;
    return result;
}

static int convert_mouse_button(uint8_t button)
{
    if (button == SDL_BUTTON_LEFT) return 0;
    if (button == SDL_BUTTON_RIGHT) return 1;
    if (button == SDL_BUTTON_MIDDLE) return 2;
    return 3;
}

bool process_sdl_event(Rml::Context& context, const SDL_Event& event)
{
    const int modifiers = get_key_modifier_state();
    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
        return context.ProcessMouseMove(int(event.motion.x), int(event.motion.y), modifiers);
    case SDL_EVENT_MOUSE_BUTTON_DOWN:
        SDL_CaptureMouse(true);
        return context.ProcessMouseButtonDown(convert_mouse_button(event.button.button), modifiers);
    case SDL_EVENT_MOUSE_BUTTON_UP: {
        const bool consumed = context.ProcessMouseButtonUp(convert_mouse_button(event.button.button), modifiers);
        SDL_CaptureMouse(false);
        return consumed;
    }
    case SDL_EVENT_MOUSE_WHEEL:
        return context.ProcessMouseWheel(-event.wheel.y, modifiers);
    case SDL_EVENT_KEY_DOWN:
        return context.ProcessKeyDown(convert_sdl_key(event.key.key), modifiers);
    case SDL_EVENT_KEY_UP:
        return context.ProcessKeyUp(convert_sdl_key(event.key.key), modifiers);
    case SDL_EVENT_TEXT_INPUT:
        return context.ProcessTextInput(Rml::String(event.text.text));
    case SDL_EVENT_FINGER_DOWN:
        {
            const bool moved = context.ProcessMouseMove(int(event.tfinger.x), int(event.tfinger.y), modifiers);
            const bool pressed = context.ProcessMouseButtonDown(0, modifiers);
            return moved || pressed;
        }
    case SDL_EVENT_FINGER_UP:
    case SDL_EVENT_FINGER_CANCELED:
        {
            const bool moved = context.ProcessMouseMove(int(event.tfinger.x), int(event.tfinger.y), modifiers);
            const bool released = context.ProcessMouseButtonUp(0, modifiers);
            return moved || released;
        }
    case SDL_EVENT_FINGER_MOTION:
        return context.ProcessMouseMove(int(event.tfinger.x), int(event.tfinger.y), modifiers);
    case SDL_EVENT_WINDOW_MOUSE_LEAVE:
        return context.ProcessMouseLeave();
    default:
        return false;
    }
}

} // namespace noveltea::ui::rmlui

#endif
