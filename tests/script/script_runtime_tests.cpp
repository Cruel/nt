#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_manager.hpp"
#include "noveltea/assets/asset_source.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"

#include <lua.hpp>
#include <sol/sol.hpp>

#include <stdexcept>
#include <memory>
#include <string>

using namespace noveltea;

namespace {

assets::AssetBytes bytes(std::string text) { return assets::AssetBytes(text.begin(), text.end()); }

struct RuntimeFixture {
    std::shared_ptr<assets::MemoryAssetSource> memory =
        std::make_shared<assets::MemoryAssetSource>();
    assets::AssetManager assets;
    script::ScriptRuntime runtime;

    RuntimeFixture() { assets.mount("project", memory); }
};

} // namespace

TEST_CASE("ScriptRuntime initializes with pinned Lua and sol2 versions")
{
    RuntimeFixture fixture;
    auto initialized = fixture.runtime.initialize({&fixture.assets});
    REQUIRE(initialized);
    CHECK(fixture.runtime.is_initialized());
    CHECK(LUA_VERSION_NUM == 505);
    CHECK(std::string(LUA_VERSION) == "Lua 5.5");
    CHECK(SOL_VERSION_MAJOR == 3);
    CHECK(SOL_VERSION_MINOR == 5);
    CHECK(SOL_VERSION_PATCH == 0);
}

TEST_CASE("ScriptRuntime keeps persistent global state across executions")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    REQUIRE(fixture.runtime.execute("count = 1", "first"));
    REQUIRE(fixture.runtime.execute("count = count + 1", "second"));
    auto result = fixture.runtime.evaluate("count", "count");
    REQUIRE(result);
    REQUIRE(std::holds_alternative<std::int64_t>(*result.value));
    CHECK(std::get<std::int64_t>(*result.value) == 2);
}

TEST_CASE("ScriptRuntime evaluates typed basic values")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto boolean = fixture.runtime.evaluate_bool("3 < 4", "bool");
    REQUIRE(boolean);
    CHECK(*boolean.value);

    auto string = fixture.runtime.evaluate_string("'Novel' .. 'Tea'", "string");
    REQUIRE(string);
    CHECK(*string.value == "NovelTea");

    auto integer = fixture.runtime.evaluate("42", "integer");
    REQUIRE(integer);
    CHECK(std::holds_alternative<std::int64_t>(*integer.value));
    CHECK(std::get<std::int64_t>(*integer.value) == 42);

    auto whole_float = fixture.runtime.evaluate("42.0", "whole_float");
    REQUIRE(whole_float);
    CHECK(std::holds_alternative<double>(*whole_float.value));
    CHECK(std::get<double>(*whole_float.value) == 42.0);

    auto floating = fixture.runtime.evaluate("42.5", "float");
    REQUIRE(floating);
    CHECK(std::holds_alternative<double>(*floating.value));
    CHECK(std::get<double>(*floating.value) == 42.5);

    auto nil = fixture.runtime.evaluate("nil", "nil");
    REQUIRE(nil);
    CHECK(std::holds_alternative<std::monostate>(*nil.value));
}

TEST_CASE("ScriptRuntime has an explicit expression return policy")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto no_return = fixture.runtime.evaluate("print('no-return')", "no_return");
    REQUIRE(no_return);
    CHECK(std::holds_alternative<std::monostate>(*no_return.value));

    auto multiple = fixture.runtime.evaluate("1, 2", "multiple");
    REQUIRE_FALSE(multiple);
    REQUIRE(multiple.error);
    CHECK(multiple.error->message.find("multiple values") != std::string::npos);

    for (const auto* expression : {"{}", "function() end", "coroutine.create(function() end)"}) {
        auto result = fixture.runtime.evaluate(expression, expression);
        REQUIRE_FALSE(result);
        REQUIRE(result.error);
        CHECK(result.error->message.find("unsupported Lua result type") != std::string::npos);
    }

    lua_State* state = script::detail::ScriptRuntimeAccess::state(fixture.runtime);
    REQUIRE(state != nullptr);
    lua_pushlightuserdata(state, &fixture);
    lua_setglobal(state, "test_userdata");
    auto userdata = fixture.runtime.evaluate("test_userdata", "userdata");
    REQUIRE_FALSE(userdata);
    REQUIRE(userdata.error);
    CHECK(userdata.error->message.find("userdata") != std::string::npos);
}

TEST_CASE("ScriptRuntime reports syntax errors and nested runtime tracebacks")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));

    auto syntax = fixture.runtime.execute("function bad(", "bad_syntax");
    REQUIRE_FALSE(syntax);
    REQUIRE(syntax.error);
    CHECK(syntax.error->chunk.find("bad_syntax") != std::string::npos);
    CHECK_FALSE(syntax.error->message.empty());
    CHECK_FALSE(syntax.error->traceback.empty());

    auto runtime = fixture.runtime.execute("error('boom')", "bad_runtime");
    REQUIRE_FALSE(runtime);
    REQUIRE(runtime.error);
    CHECK(runtime.error->message.find("boom") != std::string::npos);
    CHECK(runtime.error->traceback.find("boom") != std::string::npos);
    CHECK(runtime.error->traceback.find("stack traceback") != std::string::npos);

    auto nested = fixture.runtime.execute(R"(
        local function deepest()
            error("boom")
        end
        local function middle()
            deepest()
        end
        middle()
    )",
                                          "nested_runtime");
    REQUIRE_FALSE(nested);
    REQUIRE(nested.error);
    CHECK(nested.error->message.find("boom") != std::string::npos);
    CHECK(nested.error->chunk.find("nested_runtime") != std::string::npos);
    CHECK(nested.error->traceback.find("boom") != std::string::npos);
    CHECK(nested.error->traceback.find("nested_runtime") != std::string::npos);
    CHECK(nested.error->traceback.find("deepest") != std::string::npos);
    CHECK(nested.error->traceback.find("middle") != std::string::npos);
    CHECK(nested.error->traceback != nested.error->message);
}

TEST_CASE("ScriptRuntime does not expose unsafe standard libraries by default")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    for (const auto* name : {"os", "io", "debug", "package", "require", "dofile", "loadfile"}) {
        auto result = fixture.runtime.evaluate_bool(std::string(name) + " == nil", name);
        REQUIRE(result);
        CHECK(*result.value);
    }
    auto load_available = fixture.runtime.evaluate_bool("load ~= nil", "load");
    REQUIRE(load_available);
    CHECK(*load_available.value);
}

TEST_CASE("ScriptRuntime initialization failure leaves runtime clean")
{
    script::ScriptRuntime runtime;
    auto initialized = runtime.initialize({});
    REQUIRE_FALSE(initialized);
    REQUIRE(initialized.error);
    CHECK_FALSE(runtime.is_initialized());
    runtime.shutdown();
    CHECK_FALSE(runtime.is_initialized());
}

TEST_CASE("ScriptRuntime converts bound C++ exceptions into failures and stays usable")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    sol::state_view lua(script::detail::ScriptRuntimeAccess::state(fixture.runtime));
    lua.set_function("throw_from_cpp", []() -> int { throw std::runtime_error("cpp boom"); });

    auto failed = fixture.runtime.execute("throw_from_cpp()", "cpp_throw");
    REQUIRE_FALSE(failed);
    REQUIRE(failed.error);
    CHECK(failed.error->message.find("cpp boom") != std::string::npos);
    CHECK(failed.error->traceback.find("stack traceback") != std::string::npos);

    auto still_usable = fixture.runtime.evaluate_string("'still' .. '-ok'", "after_failure");
    REQUIRE(still_usable);
    CHECK(*still_usable.value == "still-ok");
}

TEST_CASE("ScriptRuntime executes scripts through AssetManager logical paths")
{
    RuntimeFixture fixture;
    fixture.memory->add("project:/scripts/example.lua",
                        bytes("asset_value = noveltea.echo('asset-ok')"));
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    auto executed = fixture.runtime.execute_asset("project:/scripts/example.lua");
    REQUIRE(executed);
    auto value = fixture.runtime.evaluate_string("asset_value", "asset_value");
    REQUIRE(value);
    CHECK(*value.value == "asset-ok");
}

TEST_CASE("ScriptRuntime supports shared_ptr-backed sol2 usertypes for future bindings")
{
    struct TestObject {
        explicit TestObject(std::string label) : label(std::move(label)) {}
        std::string label;
        int calls = 0;
        std::string ping()
        {
            ++calls;
            return label + ":" + std::to_string(calls);
        }
    };

    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    sol::state_view lua(script::detail::ScriptRuntimeAccess::state(fixture.runtime));
    lua.new_usertype<TestObject>(
        "TestObject", sol::no_constructor, "ping", &TestObject::ping, "calls",
        sol::property([](const TestObject& object) { return object.calls; }));

    auto object = std::make_shared<TestObject>("kept");
    std::weak_ptr<TestObject> weak = object;
    lua["test_object"] = object;
    object.reset();

    REQUIRE(fixture.runtime.execute("stored_object = test_object\nobserved = stored_object:ping()",
                                    "shared_ptr"));
    CHECK_FALSE(weak.expired());
    auto observed = fixture.runtime.evaluate_string("observed", "observed");
    REQUIRE(observed);
    CHECK(*observed.value == "kept:1");
    auto calls = fixture.runtime.evaluate("stored_object.calls", "calls");
    REQUIRE(calls);
    CHECK(std::get<std::int64_t>(*calls.value) == 1);

    REQUIRE(fixture.runtime.execute("test_object = nil\nstored_object = nil", "release"));
    fixture.runtime.collect_garbage();
    CHECK(weak.expired());
}

TEST_CASE("ScriptRuntime shutdown is idempotent and supports reinitialization")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    fixture.runtime.shutdown();
    fixture.runtime.shutdown();
    CHECK_FALSE(fixture.runtime.is_initialized());
    REQUIRE(fixture.runtime.initialize({&fixture.assets}));
    CHECK(fixture.runtime.is_initialized());
}
