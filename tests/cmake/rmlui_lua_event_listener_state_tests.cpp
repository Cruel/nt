#include <RmlUi/Core.h>
#include <RmlUi/Core/Context.h>
#include <RmlUi/Core/ElementDocument.h>
#include <RmlUi/Core/NovelTeaPatch.h>
#include <RmlUi/Core/RenderInterface.h>
#include <RmlUi/Lua.h>
#include <RmlUi/Lua/IncludeLua.h>

#include <cstdio>
#include <string_view>

#ifndef RMLUI_NOVELTEA_PATCH_REVISION
#error "The repository-owned RmlUi patch marker is missing"
#endif

#ifndef NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION
#error "The expected RmlUi patch revision was not supplied by the NovelTea build"
#endif

static_assert(std::string_view(RMLUI_NOVELTEA_PATCH_REVISION) ==
              std::string_view(NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION));

namespace {

class HeadlessRenderInterface final : public Rml::RenderInterface {
public:
    Rml::CompiledGeometryHandle CompileGeometry(Rml::Span<const Rml::Vertex>,
                                                Rml::Span<const int>) override
    {
        return ++m_next_geometry;
    }

    void RenderGeometry(Rml::CompiledGeometryHandle, Rml::Vector2f, Rml::TextureHandle) override {}
    void ReleaseGeometry(Rml::CompiledGeometryHandle) override {}

    Rml::TextureHandle LoadTexture(Rml::Vector2i& texture_dimensions, const Rml::String&) override
    {
        texture_dimensions = {0, 0};
        return 0;
    }

    Rml::TextureHandle GenerateTexture(Rml::Span<const Rml::byte>, Rml::Vector2i) override
    {
        return ++m_next_texture;
    }

    void ReleaseTexture(Rml::TextureHandle) override {}
    void EnableScissorRegion(bool) override {}
    void SetScissorRegion(Rml::Rectanglei) override {}

private:
    Rml::CompiledGeometryHandle m_next_geometry = 0;
    Rml::TextureHandle m_next_texture = 0;
};

constexpr const char* kContextName = "noveltea-rmlui-lua-event-listener-state-test";
constexpr const char* kDocument = R"(
<rml>
<head></head>
<body>
    <button id="action" onclick="return">Action</button>
</body>
</rml>
)";

int g_failures = 0;

void Expect(bool condition, const char* message)
{
    if (!condition) {
        std::fprintf(stderr, "[rmlui-lua-event-listener-state] FAILED: %s\n", message);
        ++g_failures;
    }
}

int CountFunctions(lua_State* state, int table_index)
{
    table_index = lua_absindex(state, table_index);
    int count = 0;
    lua_pushnil(state);
    while (lua_next(state, table_index) != 0) {
        if (lua_isfunction(state, -1))
            ++count;
        lua_pop(state, 1);
    }
    return count;
}

} // namespace

int main()
{
    lua_State* lua = luaL_newstate();
    if (!lua) {
        std::fprintf(stderr,
                     "[rmlui-lua-event-listener-state] FAILED: Lua state creation failed\n");
        return 1;
    }
    luaL_openlibs(lua);

    HeadlessRenderInterface render_interface;
    if (!Rml::Initialise()) {
        std::fprintf(stderr,
                     "[rmlui-lua-event-listener-state] FAILED: RmlUi initialization failed\n");
        lua_close(lua);
        return 1;
    }
    Rml::Lua::Initialise(lua);

    Rml::Context* context =
        Rml::CreateContext(kContextName, Rml::Vector2i(640, 360), &render_interface);
    if (!context) {
        std::fprintf(stderr, "[rmlui-lua-event-listener-state] FAILED: context creation failed\n");
        Rml::Shutdown();
        lua_close(lua);
        return 1;
    }

    Rml::ElementDocument* document = context->LoadDocumentFromMemory(kDocument);
    if (!document) {
        std::fprintf(stderr, "[rmlui-lua-event-listener-state] FAILED: document load failed\n");
        Rml::RemoveContext(kContextName);
        Rml::Shutdown();
        lua_close(lua);
        return 1;
    }
    document->Show();
    Expect(context->Update(), "initial context update succeeds");

    lua_getglobal(lua, "EVENTLISTENERFUNCTIONS");
    Expect(lua_istable(lua, -1), "listener function table exists in the creation environment");
    Expect(CountFunctions(lua, -1) == 1,
           "creation environment owns exactly one inline event-listener function");
    const int listener_table_ref = luaL_ref(lua, LUA_REGISTRYINDEX);

    lua_pushglobaltable(lua);
    const int original_globals_ref = luaL_ref(lua, LUA_REGISTRYINDEX);
    lua_newtable(lua);
    lua_pushvalue(lua, -1);
    lua_setfield(lua, -2, "_G");
    lua_rawseti(lua, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);

    document->Close();
    Expect(context->Update(),
           "deferred document destruction succeeds after the active Lua environment changes");

    lua_rawgeti(lua, LUA_REGISTRYINDEX, listener_table_ref);
    Expect(lua_istable(lua, -1), "creation environment listener table remains addressable");
    Expect(CountFunctions(lua, -1) == 0,
           "listener destructor releases its function from the creation environment table");
    lua_pop(lua, 1);

    lua_rawgeti(lua, LUA_REGISTRYINDEX, original_globals_ref);
    lua_rawseti(lua, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS);
    luaL_unref(lua, LUA_REGISTRYINDEX, original_globals_ref);
    luaL_unref(lua, LUA_REGISTRYINDEX, listener_table_ref);

    Rml::RemoveContext(kContextName);
    Rml::Shutdown();
    lua_close(lua);
    return g_failures == 0 ? 0 : 1;
}
