#pragma once

#include "noveltea/script/script_result.hpp"
#include "noveltea/script/script_value.hpp"

#include <memory>
#include <string>
#include <string_view>

struct lua_State;

namespace noveltea::assets { class AssetManager; }

namespace noveltea::script {

lua_State* native_lua_state(class ScriptRuntime& runtime);
const lua_State* native_lua_state(const class ScriptRuntime& runtime);

struct ScriptRuntimeConfig {
    const assets::AssetManager* assets = nullptr;
};

class ScriptRuntime {
public:
    ScriptRuntime();
    ~ScriptRuntime();

    ScriptRuntime(const ScriptRuntime&) = delete;
    ScriptRuntime& operator=(const ScriptRuntime&) = delete;

    [[nodiscard]] ScriptResult<void> initialize(ScriptRuntimeConfig config);
    void shutdown();
    [[nodiscard]] bool is_initialized() const;

    [[nodiscard]] ScriptResult<void> execute(std::string_view source, std::string_view chunk_name = "chunk");
    [[nodiscard]] ScriptResult<void> execute_asset(std::string_view logical_asset_path);
    [[nodiscard]] ScriptResult<ScriptValue> evaluate(std::string_view expression, std::string_view chunk_name = "expression");
    [[nodiscard]] ScriptResult<bool> evaluate_bool(std::string_view expression, std::string_view chunk_name = "expression");
    [[nodiscard]] ScriptResult<std::string> evaluate_string(std::string_view expression, std::string_view chunk_name = "expression");

    void collect_garbage();
    void reinstall_host_print();

private:
    friend lua_State* native_lua_state(ScriptRuntime& runtime);
    friend const lua_State* native_lua_state(const ScriptRuntime& runtime);
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace noveltea::script
