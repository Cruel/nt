#include "noveltea/ui_runtime.hpp"

#include "noveltea/assets/assets.hpp"

#include <cstdio>
#include <cstring>
#include <unordered_map>
#include <vector>

#include <SDL3/SDL.h>

#if defined(NOVELTEA_HAS_RMLUI)
#include <bx/math.h>
#endif

#if defined(NOVELTEA_HAS_RMLUI)
#include <RmlUi/Core.h>
#include <RmlUi/Core/FileInterface.h>
#endif

#include <bgfx/bgfx.h>

#if defined(NOVELTEA_HAS_RMLUI)
#include "shaders/vs_rmlui_glsl.h"
#include "shaders/fs_rmlui_glsl.h"
#include "shaders/vs_rmlui_essl.h"
#include "shaders/fs_rmlui_essl.h"
#include "shaders/vs_rmlui_web.h"
#include "shaders/fs_rmlui_web.h"
#endif

namespace noveltea {

// =========================================================================
// RmlUi bgfx render interface
// =========================================================================
#if defined(NOVELTEA_HAS_RMLUI)

namespace {

constexpr const char* kRuntimeUiFontAsset = "rmlui/LiberationSans.ttf";
constexpr const char* kRuntimeUiDocumentAsset = "rmlui/demo.rml";

class SdlFileInterface : public Rml::FileInterface
{
public:
    Rml::FileHandle Open(const Rml::String& path) override
    {
        SDL_IOStream* io = SDL_IOFromFile(path.c_str(), "rb");
        if (!io) {
            std::fprintf(stderr, "[rmlui] failed to open %s: %s\n", path.c_str(), SDL_GetError());
        }
        return reinterpret_cast<Rml::FileHandle>(io);
    }

    void Close(Rml::FileHandle file) override
    {
        if (file) {
            SDL_CloseIO(reinterpret_cast<SDL_IOStream*>(file));
        }
    }

    size_t Read(void* buffer, size_t size, Rml::FileHandle file) override
    {
        return SDL_ReadIO(reinterpret_cast<SDL_IOStream*>(file), buffer, size);
    }

    bool Seek(Rml::FileHandle file, long offset, int origin) override
    {
        SDL_IOWhence whence = SDL_IO_SEEK_SET;
        if (origin == SEEK_CUR) {
            whence = SDL_IO_SEEK_CUR;
        } else if (origin == SEEK_END) {
            whence = SDL_IO_SEEK_END;
        }
        return SDL_SeekIO(reinterpret_cast<SDL_IOStream*>(file), offset, whence) >= 0;
    }

    size_t Tell(Rml::FileHandle file) override
    {
        const Sint64 pos = SDL_TellIO(reinterpret_cast<SDL_IOStream*>(file));
        return pos >= 0 ? static_cast<size_t>(pos) : 0;
    }
};

} // namespace

struct CompiledRmlGeometry
{
    bgfx::VertexBufferHandle vb = BGFX_INVALID_HANDLE;
    bgfx::IndexBufferHandle ib = BGFX_INVALID_HANDLE;
    Rml::TextureHandle texture = 0;
};

static bgfx::ShaderHandle load_rmlui_shader(
    bgfx::RendererType::Enum type,
    const uint8_t* glsl, uint32_t glsl_len,
    const uint8_t* essl, uint32_t essl_len,
    const uint8_t* web, uint32_t web_len)
{
    const uint8_t* data = nullptr;
    uint32_t len = 0;
    switch (type) {
    case bgfx::RendererType::OpenGL:
        data = glsl; len = glsl_len;
        break;
    case bgfx::RendererType::OpenGLES:
#if defined(NOVELTEA_PLATFORM_WEB)
        data = web; len = web_len;
#else
        data = essl; len = essl_len;
#endif
        break;
    default:
        std::fprintf(stderr, "[rmlui] unsupported bgfx renderer type %d\n", static_cast<int>(type));
        return BGFX_INVALID_HANDLE;
    }
    const bgfx::Memory* mem = bgfx::alloc(len + 1);
    std::memcpy(mem->data, data, len);
    mem->data[len] = 0;
    bgfx::ShaderHandle h = bgfx::createShader(mem);
    if (!bgfx::isValid(h)) {
        std::fprintf(stderr, "[rmlui] shader creation failed\n");
    }
    return h;
}

class BgfxRenderInterface : public Rml::RenderInterface
{
public:
    BgfxRenderInterface(int width, int height, bgfx::ViewId view_id)
        : m_view_id(view_id)
    {
        m_vertex_layout.begin()
            .add(bgfx::Attrib::Position, 2, bgfx::AttribType::Float)
            .add(bgfx::Attrib::Color0, 4, bgfx::AttribType::Float)
            .add(bgfx::Attrib::TexCoord0, 2, bgfx::AttribType::Float)
            .end();

        bgfx::RendererType::Enum type = bgfx::getRendererType();
        bgfx::ShaderHandle vs = load_rmlui_shader(
            type,
            vs_rmlui_glsl, sizeof(vs_rmlui_glsl),
            vs_rmlui_essl, sizeof(vs_rmlui_essl),
            vs_rmlui_web, sizeof(vs_rmlui_web));
        bgfx::ShaderHandle fs = load_rmlui_shader(
            type,
            fs_rmlui_glsl, sizeof(fs_rmlui_glsl),
            fs_rmlui_essl, sizeof(fs_rmlui_essl),
            fs_rmlui_web, sizeof(fs_rmlui_web));

        if (bgfx::isValid(vs) && bgfx::isValid(fs)) {
            m_program = bgfx::createProgram(vs, fs, true);
            if (!bgfx::isValid(m_program)) {
                std::fprintf(stderr, "[rmlui] program creation failed\n");
            }
        } else {
            if (bgfx::isValid(vs)) bgfx::destroy(vs);
            if (bgfx::isValid(fs)) bgfx::destroy(fs);
        }

        m_sampler_uniform = bgfx::createUniform("s_texColor", bgfx::UniformType::Sampler);
        m_projection_uniform = bgfx::createUniform("u_projection", bgfx::UniformType::Mat4);
        m_transform_uniform = bgfx::createUniform("u_transform", bgfx::UniformType::Mat4);
        m_translate_uniform = bgfx::createUniform("u_translate", bgfx::UniformType::Vec4);

        auto white_mem = bgfx::alloc(4);
        std::memset(white_mem->data, 0xFF, 4);
        m_white_texture = bgfx::createTexture2D(1, 1, false, 1, bgfx::TextureFormat::RGBA8, 0, white_mem);

        resize(width, height);
    }

    ~BgfxRenderInterface() override
    {
        for (auto& [handle, geom] : m_compiled_geometry) {
            if (bgfx::isValid(geom.vb)) bgfx::destroy(geom.vb);
            if (bgfx::isValid(geom.ib)) bgfx::destroy(geom.ib);
        }
        m_compiled_geometry.clear();

        for (auto& [handle, tex] : m_textures) {
            if (bgfx::isValid(tex)) bgfx::destroy(tex);
        }
        m_textures.clear();

        if (bgfx::isValid(m_white_texture)) bgfx::destroy(m_white_texture);
        if (bgfx::isValid(m_program)) bgfx::destroy(m_program);
        if (bgfx::isValid(m_sampler_uniform)) bgfx::destroy(m_sampler_uniform);
        if (bgfx::isValid(m_projection_uniform)) bgfx::destroy(m_projection_uniform);
        if (bgfx::isValid(m_transform_uniform)) bgfx::destroy(m_transform_uniform);
        if (bgfx::isValid(m_translate_uniform)) bgfx::destroy(m_translate_uniform);
    }

    void resize(int width, int height)
    {
        m_width = width;
        m_height = height;
        bx::mtxOrtho(
            m_projection,
            0.0f, static_cast<float>(width),
            static_cast<float>(height), 0.0f,
            -10000.0f, 10000.0f, 0.0f,
            bgfx::getCaps()->homogeneousDepth);
    }

    struct FloatVertex {
        float px, py;
        float r, g, b, a;
        float u, v;
    };

    Rml::CompiledGeometryHandle CompileGeometry(
        Rml::Span<const Rml::Vertex> vertices,
        Rml::Span<const int> indices) override
    {
        // RmlUi::Vertex uses packed uint8 colour (4 bytes); bgfx reorders
        // packed attributes for alignment (see Color0 offset 16 in debug
        // output even though colour is at byte offset 8 in RmlUi::Vertex).
        // Convert to all-float on CPU so our layout matches bgfx's.
        const uint32_t nv = static_cast<uint32_t>(vertices.size());
        std::vector<FloatVertex> converted(nv);
        for (uint32_t i = 0; i < nv; ++i) {
            converted[i].px = vertices[i].position.x;
            converted[i].py = vertices[i].position.y;
            converted[i].r = static_cast<float>(vertices[i].colour.red) / 255.0f;
            converted[i].g = static_cast<float>(vertices[i].colour.green) / 255.0f;
            converted[i].b = static_cast<float>(vertices[i].colour.blue) / 255.0f;
            converted[i].a = static_cast<float>(vertices[i].colour.alpha) / 255.0f;
            converted[i].u = vertices[i].tex_coord.x;
            converted[i].v = vertices[i].tex_coord.y;
        }

        const uint32_t vb_size = nv * static_cast<uint32_t>(sizeof(FloatVertex));
        const bgfx::Memory* vb_mem = bgfx::alloc(vb_size);
        std::memcpy(vb_mem->data, converted.data(), vb_size);

        const bgfx::Memory* ib_mem = bgfx::alloc(
            static_cast<uint32_t>(indices.size() * static_cast<int>(sizeof(int))));
        std::memcpy(ib_mem->data, indices.data(), ib_mem->size);

        CompiledRmlGeometry geom;
        geom.vb = bgfx::createVertexBuffer(vb_mem, m_vertex_layout);
        geom.ib = bgfx::createIndexBuffer(ib_mem, BGFX_BUFFER_INDEX32);

        const auto handle = ++m_geometry_counter;
        m_compiled_geometry[handle] = geom;
        return handle;
    }

    void RenderGeometry(
        Rml::CompiledGeometryHandle handle,
        Rml::Vector2f translation,
        Rml::TextureHandle texture) override
    {
        auto it = m_compiled_geometry.find(handle);
        if (it == m_compiled_geometry.end())
            return;
        const CompiledRmlGeometry& geom = it->second;
        submit(geom.vb, geom.ib, translation, texture ? texture : geom.texture);
    }

    void ReleaseGeometry(Rml::CompiledGeometryHandle handle) override
    {
        auto it = m_compiled_geometry.find(handle);
        if (it == m_compiled_geometry.end())
            return;
        if (bgfx::isValid(it->second.vb)) bgfx::destroy(it->second.vb);
        if (bgfx::isValid(it->second.ib)) bgfx::destroy(it->second.ib);
        m_compiled_geometry.erase(it);
    }

    Rml::TextureHandle LoadTexture(
        Rml::Vector2i& /*textureDimensions*/,
        const Rml::String& source) override
    {
        // Deferred: bimg-based image loading or stb_image would go here.
        // The default font engine's font textures are supplied via GenerateTexture,
        // not LoadTexture, so fonts still render correctly.
        std::fprintf(stderr, "[rmlui] LoadTexture from file not yet implemented: %s\n", source.c_str());
        return 0;
    }

    Rml::TextureHandle GenerateTexture(
        Rml::Span<const Rml::byte> source,
        Rml::Vector2i sourceDimensions) override
    {
        if (!bgfx::isTextureValid(
                0, false, 1, bgfx::TextureFormat::RGBA8, 0))
            return 0;

        const bgfx::Memory* mem = bgfx::alloc(
            static_cast<uint32_t>(source.size()));
        std::memcpy(mem->data, source.data(), mem->size);

        bgfx::TextureHandle tex = bgfx::createTexture2D(
            static_cast<uint16_t>(sourceDimensions.x),
            static_cast<uint16_t>(sourceDimensions.y),
            false, 1, bgfx::TextureFormat::RGBA8, 0, mem);

        if (!bgfx::isValid(tex))
            return 0;

        const auto handle = ++m_texture_counter;
        m_textures[handle] = tex;
        return handle;
    }

    void ReleaseTexture(Rml::TextureHandle handle) override
    {
        auto it = m_textures.find(handle);
        if (it == m_textures.end())
            return;
        if (bgfx::isValid(it->second)) bgfx::destroy(it->second);
        m_textures.erase(it);
    }

    void EnableScissorRegion(bool enable) override
    {
        m_scissor_enabled = enable;
    }

    void SetScissorRegion(Rml::Rectanglei region) override
    {
        m_scissor_region = region;
    }

    void SetTransform(const Rml::Matrix4f* transform) override
    {
        if (transform) {
            m_transform_valid = true;
            std::memcpy(m_transform, transform->data(), 16 * sizeof(float));
        } else {
            m_transform_valid = false;
        }
    }

private:
    void submit(
        bgfx::VertexBufferHandle vb, bgfx::IndexBufferHandle ib,
        Rml::Vector2f translation, Rml::TextureHandle texture)
    {
        if (!bgfx::isValid(m_program))
            return;

        bgfx::setVertexBuffer(0, vb);
        bgfx::setIndexBuffer(ib);
        bgfx::setUniform(m_projection_uniform, m_projection);

        if (m_transform_valid) {
            bgfx::setUniform(m_transform_uniform, m_transform);
        } else {
            float identity[16];
            bx::mtxIdentity(identity);
            bgfx::setUniform(m_transform_uniform, identity);
        }

        float translate[4] = {translation.x, translation.y, 0.0f, 0.0f};
        bgfx::setUniform(m_translate_uniform, translate);

        auto tex_it = m_textures.find(texture);
        bgfx::TextureHandle tex = (tex_it != m_textures.end())
            ? tex_it->second
            : m_white_texture;
        bgfx::setTexture(0, m_sampler_uniform, tex);

        if (m_scissor_enabled) {
            bgfx::setScissor(
                m_scissor_region.Left(),
                m_scissor_region.Top(),
                m_scissor_region.Width(),
                m_scissor_region.Height());
        }

        bgfx::setState(
            BGFX_STATE_WRITE_RGB
            | BGFX_STATE_WRITE_A
            | BGFX_STATE_BLEND_ALPHA);
        bgfx::submit(m_view_id, m_program);
    }

    bgfx::ViewId m_view_id = 1;
    bgfx::VertexLayout m_vertex_layout;
    bgfx::ProgramHandle m_program = BGFX_INVALID_HANDLE;
    bgfx::TextureHandle m_white_texture = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_sampler_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_projection_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_transform_uniform = BGFX_INVALID_HANDLE;
    bgfx::UniformHandle m_translate_uniform = BGFX_INVALID_HANDLE;

    uint64_t m_geometry_counter = 0;
    std::unordered_map<Rml::CompiledGeometryHandle, CompiledRmlGeometry> m_compiled_geometry;

    uint64_t m_texture_counter = 0;
    std::unordered_map<Rml::TextureHandle, bgfx::TextureHandle> m_textures;

    int m_width = 0;
    int m_height = 0;
    float m_projection[16];
    float m_transform[16];
    bool m_transform_valid = false;
    bool m_scissor_enabled = false;
    Rml::Rectanglei m_scissor_region;
};

// =========================================================================
// Minimal RmlUi SystemInterface for SDL3 time
// =========================================================================

class BgfxSystemInterface : public Rml::SystemInterface
{
public:
    double GetElapsedTime() override
    {
        static const uint64_t start = SDL_GetPerformanceCounter();
        static const double frequency = static_cast<double>(SDL_GetPerformanceFrequency());
        return static_cast<double>(SDL_GetPerformanceCounter() - start) / frequency;
    }
};

// =========================================================================
// SDL3 key/modifier conversion (adapted from RmlUi Backends reference)
// =========================================================================

static Rml::Input::KeyIdentifier convert_sdl_key(int sdl_key)
{
    switch (sdl_key) {
    case SDLK_UNKNOWN:      return Rml::Input::KI_UNKNOWN;
    case SDLK_ESCAPE:       return Rml::Input::KI_ESCAPE;
    case SDLK_SPACE:        return Rml::Input::KI_SPACE;
    case SDLK_0:            return Rml::Input::KI_0;
    case SDLK_1:            return Rml::Input::KI_1;
    case SDLK_2:            return Rml::Input::KI_2;
    case SDLK_3:            return Rml::Input::KI_3;
    case SDLK_4:            return Rml::Input::KI_4;
    case SDLK_5:            return Rml::Input::KI_5;
    case SDLK_6:            return Rml::Input::KI_6;
    case SDLK_7:            return Rml::Input::KI_7;
    case SDLK_8:            return Rml::Input::KI_8;
    case SDLK_9:            return Rml::Input::KI_9;
    case SDLK_A:            return Rml::Input::KI_A;
    case SDLK_B:            return Rml::Input::KI_B;
    case SDLK_C:            return Rml::Input::KI_C;
    case SDLK_D:            return Rml::Input::KI_D;
    case SDLK_E:            return Rml::Input::KI_E;
    case SDLK_F:            return Rml::Input::KI_F;
    case SDLK_G:            return Rml::Input::KI_G;
    case SDLK_H:            return Rml::Input::KI_H;
    case SDLK_I:            return Rml::Input::KI_I;
    case SDLK_J:            return Rml::Input::KI_J;
    case SDLK_K:            return Rml::Input::KI_K;
    case SDLK_L:            return Rml::Input::KI_L;
    case SDLK_M:            return Rml::Input::KI_M;
    case SDLK_N:            return Rml::Input::KI_N;
    case SDLK_O:            return Rml::Input::KI_O;
    case SDLK_P:            return Rml::Input::KI_P;
    case SDLK_Q:            return Rml::Input::KI_Q;
    case SDLK_R:            return Rml::Input::KI_R;
    case SDLK_S:            return Rml::Input::KI_S;
    case SDLK_T:            return Rml::Input::KI_T;
    case SDLK_U:            return Rml::Input::KI_U;
    case SDLK_V:            return Rml::Input::KI_V;
    case SDLK_W:            return Rml::Input::KI_W;
    case SDLK_X:            return Rml::Input::KI_X;
    case SDLK_Y:            return Rml::Input::KI_Y;
    case SDLK_Z:            return Rml::Input::KI_Z;
    case SDLK_RETURN:       return Rml::Input::KI_RETURN;
    case SDLK_BACKSPACE:    return Rml::Input::KI_BACK;
    case SDLK_TAB:          return Rml::Input::KI_TAB;
    case SDLK_DELETE:       return Rml::Input::KI_DELETE;
    case SDLK_LEFT:         return Rml::Input::KI_LEFT;
    case SDLK_UP:           return Rml::Input::KI_UP;
    case SDLK_RIGHT:        return Rml::Input::KI_RIGHT;
    case SDLK_DOWN:         return Rml::Input::KI_DOWN;
    case SDLK_HOME:         return Rml::Input::KI_HOME;
    case SDLK_END:          return Rml::Input::KI_END;
    case SDLK_PAGEUP:       return Rml::Input::KI_PRIOR;
    case SDLK_PAGEDOWN:     return Rml::Input::KI_NEXT;
    case SDLK_INSERT:       return Rml::Input::KI_INSERT;
    case SDLK_LSHIFT:       return Rml::Input::KI_LSHIFT;
    case SDLK_RSHIFT:       return Rml::Input::KI_RSHIFT;
    case SDLK_LCTRL:        return Rml::Input::KI_LCONTROL;
    case SDLK_RCTRL:        return Rml::Input::KI_RCONTROL;
    case SDLK_LALT:         return Rml::Input::KI_LMENU;
    case SDLK_RALT:         return Rml::Input::KI_RMENU;
    case SDLK_LGUI:         return Rml::Input::KI_LMETA;
    case SDLK_RGUI:         return Rml::Input::KI_RMETA;
    case SDLK_F1:           return Rml::Input::KI_F1;
    case SDLK_F2:           return Rml::Input::KI_F2;
    case SDLK_F3:           return Rml::Input::KI_F3;
    case SDLK_F4:           return Rml::Input::KI_F4;
    case SDLK_F5:           return Rml::Input::KI_F5;
    case SDLK_F6:           return Rml::Input::KI_F6;
    case SDLK_F7:           return Rml::Input::KI_F7;
    case SDLK_F8:           return Rml::Input::KI_F8;
    case SDLK_F9:           return Rml::Input::KI_F9;
    case SDLK_F10:          return Rml::Input::KI_F10;
    case SDLK_F11:          return Rml::Input::KI_F11;
    case SDLK_F12:          return Rml::Input::KI_F12;
    default:                return Rml::Input::KI_UNKNOWN;
    }
}

static int get_key_modifier_state()
{
    SDL_Keymod mods = SDL_GetModState();
    int result = 0;
    if (mods & SDL_KMOD_CTRL)  result |= Rml::Input::KM_CTRL;
    if (mods & SDL_KMOD_SHIFT) result |= Rml::Input::KM_SHIFT;
    if (mods & SDL_KMOD_ALT)   result |= Rml::Input::KM_ALT;
    if (mods & SDL_KMOD_NUM)   result |= Rml::Input::KM_NUMLOCK;
    if (mods & SDL_KMOD_CAPS)  result |= Rml::Input::KM_CAPSLOCK;
    return result;
}

#endif // NOVELTEA_HAS_RMLUI

// =========================================================================
// RuntimeUI opaque state
// =========================================================================

struct RuntimeUI::State
{
#if defined(NOVELTEA_HAS_RMLUI)
    Rml::Context* context = nullptr;
    Rml::ElementDocument* demo_document = nullptr;
    SdlFileInterface* file_interface = nullptr;
    BgfxRenderInterface* render_interface = nullptr;
    BgfxSystemInterface* system_interface = nullptr;
#endif
};

// =========================================================================
// RuntimeUI public API
// =========================================================================

RuntimeUI::RuntimeUI() = default;
RuntimeUI::~RuntimeUI() { shutdown(); }

bool RuntimeUI::initialize()
{
    if (m_initialized) return true;

#if defined(NOVELTEA_HAS_RMLUI)
    std::printf("[runtime_ui] initializing RmlUi...\n");

    m_state = new State;

    m_state->file_interface = new SdlFileInterface;
    m_state->system_interface = new BgfxSystemInterface;
    Rml::SetFileInterface(m_state->file_interface);
    Rml::SetSystemInterface(m_state->system_interface);

    if (!Rml::Initialise()) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::Initialise() failed\n");
        delete m_state->file_interface;
        delete m_state->system_interface;
        delete m_state;
        m_state = nullptr;
        return false;
    }

    m_state->render_interface = new BgfxRenderInterface(m_width, m_height, 1);

    m_state->context = Rml::CreateContext(
        "main",
        Rml::Vector2i(m_width, m_height),
        m_state->render_interface);

    if (!m_state->context) {
        std::fprintf(stderr, "[runtime_ui] RmlUi::CreateContext failed\n");
        delete m_state->render_interface;
        delete m_state->file_interface;
        delete m_state->system_interface;
        delete m_state;
        m_state = nullptr;
        Rml::Shutdown();
        return false;
    }

    const std::filesystem::path asset_root = default_asset_root();
    const std::filesystem::path font_path = resolve_asset_path(kRuntimeUiFontAsset);
    const std::filesystem::path document_path = resolve_asset_path(kRuntimeUiDocumentAsset);

    std::printf("[runtime_ui] asset root: %s\n", asset_root.string().c_str());
    Rml::LoadFontFace(font_path.string(), true);

    Rml::ElementDocument* doc = m_state->context->LoadDocument(document_path.string());
    if (doc) {
        doc->Show();
        m_state->demo_document = doc;
        std::printf("[runtime_ui] demo document loaded\n");
    } else {
        std::fprintf(stderr, "[runtime_ui] failed to load demo document\n");
    }

    std::printf("[runtime_ui] RmlUi initialized (%dx%d)\n", m_width, m_height);
#else
    std::printf(
        "[runtime_ui] RmlUi scaffold active"
        " (RmlUi library not linked for this target)\n");
#endif

    m_initialized = true;
    return true;
}

void RuntimeUI::process_event(const SDL_Event& event)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (!m_state || !m_state->context)
        return;

    switch (event.type) {
    case SDL_EVENT_MOUSE_MOTION:
        m_state->context->ProcessMouseMove(
            static_cast<int>(event.motion.x),
            static_cast<int>(event.motion.y),
            get_key_modifier_state());
        break;

    case SDL_EVENT_MOUSE_BUTTON_DOWN: {
        int button = 0;
        switch (event.button.button) {
        case SDL_BUTTON_LEFT:   button = 0; break;
        case SDL_BUTTON_RIGHT:  button = 1; break;
        case SDL_BUTTON_MIDDLE: button = 2; break;
        default:                button = 3; break;
        }
        m_state->context->ProcessMouseButtonDown(button, get_key_modifier_state());
        break;
    }

    case SDL_EVENT_MOUSE_BUTTON_UP: {
        int button = 0;
        switch (event.button.button) {
        case SDL_BUTTON_LEFT:   button = 0; break;
        case SDL_BUTTON_RIGHT:  button = 1; break;
        case SDL_BUTTON_MIDDLE: button = 2; break;
        default:                button = 3; break;
        }
        m_state->context->ProcessMouseButtonUp(button, get_key_modifier_state());
        break;
    }

    case SDL_EVENT_MOUSE_WHEEL:
        m_state->context->ProcessMouseWheel(
            static_cast<float>(-event.wheel.y),
            get_key_modifier_state());
        break;

    case SDL_EVENT_KEY_DOWN:
        m_state->context->ProcessKeyDown(
            convert_sdl_key(event.key.key),
            get_key_modifier_state());
        if (event.key.key == SDLK_RETURN
            || event.key.key == SDLK_KP_ENTER)
        {
            m_state->context->ProcessTextInput('\n');
        }
        break;

    case SDL_EVENT_KEY_UP:
        m_state->context->ProcessKeyUp(
            convert_sdl_key(event.key.key),
            get_key_modifier_state());
        break;

    case SDL_EVENT_TEXT_INPUT:
        m_state->context->ProcessTextInput(
            Rml::String(&event.text.text[0]));
        break;

    default:
        break;
    }
#else
    (void)event;
#endif
}

void RuntimeUI::resize(int width, int height)
{
    m_width = width;
    m_height = height;

#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state) {
        if (m_state->context)
            m_state->context->SetDimensions(Rml::Vector2i(width, height));
        if (m_state->render_interface)
            m_state->render_interface->resize(width, height);
    }
#else
    (void)width;
    (void)height;
#endif
}

void RuntimeUI::begin_frame(float delta_time)
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context)
        m_state->context->Update();
#else
    (void)delta_time;
#endif
}

void RuntimeUI::end_frame()
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context)
        m_state->context->Render();
#endif
}

void RuntimeUI::shutdown()
{
    if (!m_initialized) return;

#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state) {
        std::printf("[runtime_ui] shutting down RmlUi...\n");

        if (m_state->context) {
            m_state->context->UnloadAllDocuments();
            Rml::RemoveContext("main");
            m_state->context = nullptr;
        }

        // Destroy render interface after Rml::Shutdown to avoid
        // "still actively referenced" warning.
        Rml::Shutdown();

        delete m_state->render_interface;
        m_state->render_interface = nullptr;

        delete m_state->system_interface;
        m_state->system_interface = nullptr;

        delete m_state->file_interface;
        m_state->file_interface = nullptr;

        delete m_state;
        m_state = nullptr;

        std::printf("[runtime_ui] RmlUi shutdown complete\n");
    }
#else
    std::printf("[runtime_ui] scaffold shutdown\n");
#endif

    m_initialized = false;
}

const char* RuntimeUI::backend_name() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    return "RmlUi (bgfx)";
#else
    return "RmlUi scaffold (not linked)";
#endif
}

const char* RuntimeUI::status_text() const
{
#if defined(NOVELTEA_HAS_RMLUI)
    if (m_state && m_state->context)
        return "rendering";
    return "no context";
#else
    return "not linked for this target";
#endif
}

} // namespace noveltea
