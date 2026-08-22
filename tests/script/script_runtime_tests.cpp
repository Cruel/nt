#include <catch2/catch_test_macros.hpp>

#include "noveltea/core/compiled_project_codec.hpp"
#include "noveltea/core/flow_executor.hpp"
#include "noveltea/core/session_state.hpp"
#include "noveltea/runtime/runtime_command_gateway.hpp"
#include "noveltea/script/runtime_script_api.hpp"
#include "noveltea/script/script_runtime.hpp"
#include "script/lua/script_runtime_internal.hpp"
#include "fake_script_source.hpp"

#include <lua.hpp>
#include <nlohmann/json.hpp>
#include <sol/sol.hpp>

#include <fstream>
#include <memory>
#include <string>
#include <type_traits>
#include <vector>

using namespace noveltea;

namespace {

std::vector<std::uint8_t> bytes(std::string text)
{
    return std::vector<std::uint8_t>(text.begin(), text.end());
}

template<class Command> bool is_runtime_command(const runtime::DeferredRuntimeCommand& command)
{
    return std::holds_alternative<Command>(command.payload);
}

core::CompiledProject load_compiled_fixture(std::string_view filename)
{
    std::ifstream input(std::string(NOVELTEA_SOURCE_DIR) +
                        "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                        std::string(filename));
    REQUIRE(input.good());
    const std::string source((std::istreambuf_iterator<char>(input)),
                             std::istreambuf_iterator<char>());
    auto document = nlohmann::json::parse(source, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    auto decoded = core::decode_compiled_project(document, std::string(filename));
    REQUIRE(decoded);
    return std::move(decoded).value();
}

core::CompiledProject load_script_project() { return load_compiled_fixture("scene-program.json"); }

core::CompiledProject
load_script_project_with_modules(std::initializer_list<std::pair<std::string, std::string>> modules,
                                 std::string bootstrap_module = "bootstrap")
{
    std::ifstream input(
        std::string(NOVELTEA_SOURCE_DIR) +
        "/editor/src/renderer/test/fixtures/compiled-project-golden/scene-program.json");
    REQUIRE(input.good());
    auto document = nlohmann::json::parse(input, nullptr, false);
    REQUIRE_FALSE(document.is_discarded());
    document["resources"]["scripts"] = nlohmann::json::array();
    for (const auto& [id, source] : modules) {
        document["resources"]["scripts"].push_back(
            {{"id", id}, {"source", {{"kind", "inline-lua"}, {"source", source}}}});
    }
    document["bootstrapModule"] = {{"kind", "script"}, {"id", std::move(bootstrap_module)}};
    auto decoded = core::decode_compiled_project(document, "script-module-test");
    REQUIRE(decoded);
    return std::move(decoded).value();
}

struct RuntimeFixture {
    test_support::MemoryScriptSource sources;
    script::ScriptRuntime runtime;
};

class FocusedCountQueryProvider final : public runtime::RuntimeQueryProvider {
public:
    explicit FocusedCountQueryProvider(runtime::CapabilityGeneration generation) noexcept
        : m_generation(generation)
    {
    }

    [[nodiscard]] bool active(runtime::CapabilityGeneration generation) const noexcept override
    {
        return generation == m_generation;
    }
    [[nodiscard]] core::Result<core::ProjectDefinitionSummary, core::Diagnostics>
    definition(core::ProjectDefinitionKind, std::string) const override
    {
        return core::Result<core::ProjectDefinitionSummary, core::Diagnostics>::failure(
            {{.code = "test.unadmitted", .message = "Definition is not admitted"}});
    }
    [[nodiscard]] core::Result<core::RuntimeValue, core::Diagnostics>
    global_property(const core::PropertyId& id) const override
    {
        if (id.text() == "count")
            return core::Result<core::RuntimeValue, core::Diagnostics>::success(std::int64_t{2});
        return core::Result<core::RuntimeValue, core::Diagnostics>::failure(
            {{.code = "test.unadmitted", .message = "Global Property is not admitted"}});
    }
    [[nodiscard]] core::Result<core::PropertyLookupResult, core::Diagnostics>
    property(const core::PropertyOwnerRef&, const core::PropertyId&) const override
    {
        return core::Result<core::PropertyLookupResult, core::Diagnostics>::failure(
            {{.code = "test.unadmitted", .message = "Property is not admitted"}});
    }
    [[nodiscard]] core::Result<core::compiled::InteractableLocation, core::Diagnostics>
    interactable_location(const core::InteractableId&) const override
    {
        return core::Result<core::compiled::InteractableLocation, core::Diagnostics>::failure(
            {{.code = "test.unadmitted", .message = "Interactable is not admitted"}});
    }
    [[nodiscard]] core::Result<core::CharacterWorldLocation, core::Diagnostics>
    character_location(const core::CharacterId&) const override
    {
        return core::Result<core::CharacterWorldLocation, core::Diagnostics>::failure(
            {{.code = "test.unadmitted", .message = "Character is not admitted"}});
    }

private:
    runtime::CapabilityGeneration m_generation;
};

script::ScriptError blocker_error(const core::Diagnostics& diagnostics, std::string operation)
{
    const std::string message =
        diagnostics.empty() ? "Script invocation blocker is invalid" : diagnostics.front().message;
    return script::ScriptError{script::ScriptErrorCode::StaleInvocation, message,
                               std::move(operation), message};
}

runtime::RuntimeCapabilitySet issue_capabilities(runtime::RuntimeCommandGateway& gateway,
                                                 runtime::RuntimeCapabilityProfile profile)
{
    runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
    auto issued = issuer.issue(profile);
    REQUIRE(issued.has_value());
    return *issued;
}

class ScriptInvocationHarness {
public:
    ScriptInvocationHarness(script::ScriptRuntime& runtime, const core::CompiledProject& project,
                            core::SessionState& state, core::FlowExecutor& flow)
        : m_runtime(runtime), m_flow(flow), m_world(project, state),
          m_gateway(project, state, m_world, *runtime::CapabilityGeneration::from_number(1)),
          m_gameplay(
              issue_capabilities(m_gateway, runtime::RuntimeCapabilityProfile::GameplayScript)),
          m_expression(issue_capabilities(m_gateway,
                                          runtime::RuntimeCapabilityProfile::SynchronousExpression))
    {
    }

    [[nodiscard]] runtime::RuntimeCommandGateway& gateway() noexcept { return m_gateway; }
    [[nodiscard]] const runtime::RuntimeCapabilitySet& gameplay_capabilities() const noexcept
    {
        return m_gameplay;
    }
    [[nodiscard]] const runtime::RuntimeCapabilitySet& expression_capabilities() const noexcept
    {
        return m_expression;
    }

    [[nodiscard]] core::Result<bool, script::ScriptError>
    evaluate(const core::LuaPredicate& predicate)
    {
        auto invoked = invoke_immediate(predicate.source, "lua-condition",
                                        runtime::ScriptInvocationResultKind::Boolean, m_expression);
        const auto* outcome = invoked.value_if();
        const auto* completed =
            outcome == nullptr ? nullptr : std::get_if<runtime::ScriptInvocationCompleted>(outcome);
        const auto* value = completed == nullptr ? nullptr : std::get_if<bool>(&completed->value);
        return value ? core::Result<bool, script::ScriptError>::success(*value)
                     : core::Result<bool, script::ScriptError>::failure(
                           outcome == nullptr
                               ? invoked.error()
                               : script::ScriptError{
                                     .code = script::ScriptErrorCode::InvalidResult,
                                     .message = "Script condition did not return a boolean",
                                     .chunk = "lua-condition",
                                     .traceback = {}});
    }

    [[nodiscard]] core::Result<std::string, script::ScriptError>
    resolve(const core::LuaTextExpression& expression)
    {
        auto invoked = invoke_immediate(expression.source, "lua-text-expression",
                                        runtime::ScriptInvocationResultKind::String, m_expression);
        const auto* outcome = invoked.value_if();
        const auto* completed =
            outcome == nullptr ? nullptr : std::get_if<runtime::ScriptInvocationCompleted>(outcome);
        const auto* value =
            completed == nullptr ? nullptr : std::get_if<std::string>(&completed->value);
        return value ? core::Result<std::string, script::ScriptError>::success(*value)
                     : core::Result<std::string, script::ScriptError>::failure(
                           outcome == nullptr
                               ? invoked.error()
                               : script::ScriptError{
                                     .code = script::ScriptErrorCode::InvalidResult,
                                     .message = "Script text expression did not return a string",
                                     .chunk = "lua-text-expression",
                                     .traceback = {}});
    }

    [[nodiscard]] core::Result<script::ScriptInvocationOutcome, script::ScriptError>
    invoke(const core::RunLuaEffect& effect, std::string_view chunk_name)
    {
        return invoke(effect.source, chunk_name);
    }

    [[nodiscard]] core::Result<script::ScriptInvocationOutcome, script::ScriptError>
    invoke(std::string_view source, std::string_view chunk_name)
    {
        using Result = core::Result<script::ScriptInvocationOutcome, script::ScriptError>;
        auto allocated = m_flow.block_top(core::FlowBlockerKind::Script);
        const auto* blocker = allocated.value_if();
        if (blocker == nullptr)
            return Result::failure(blocker_error(allocated.error(), std::string(chunk_name)));
        const auto* script_blocker = std::get_if<core::ScriptFlowBlocker>(blocker);
        REQUIRE(script_blocker != nullptr);

        runtime::ScriptInvocationRequest request{
            .source = std::string(source),
            .chunk_name = std::string(chunk_name),
            .owner = script_blocker->owner,
            .invocation = script_blocker->handle,
            .source_context = m_gateway.current_source_context(),
            .result_kind = runtime::ScriptInvocationResultKind::None};
        auto invoked = m_runtime.invoke(request, m_gameplay);
        if (!invoked) {
            (void)m_flow.cancel_blocker(script_blocker->owner, script_blocker->handle);
            return Result::failure(invoked.error());
        }
        if (std::holds_alternative<script::ScriptInvocationCompleted>(*invoked.value_if())) {
            auto completed = m_flow.resume_blocker(script_blocker->owner, script_blocker->handle);
            if (!completed)
                return Result::failure(blocker_error(completed.error(), std::string(chunk_name)));
        }
        return invoked;
    }

    [[nodiscard]] core::Result<script::ScriptInvocationOutcome, script::ScriptError>
    resume(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation)
    {
        using Result = core::Result<script::ScriptInvocationOutcome, script::ScriptError>;
        auto valid = m_flow.validate_blocker(owner, invocation);
        if (!valid)
            return Result::failure(blocker_error(valid.error(), "resume"));
        auto resumed = m_runtime.resume(invocation, m_gameplay);
        if (!resumed) {
            (void)m_flow.cancel_blocker(owner, invocation);
            return Result::failure(resumed.error());
        }
        if (std::holds_alternative<script::ScriptInvocationCompleted>(*resumed.value_if())) {
            auto completed = m_flow.resume_blocker(owner, invocation);
            if (!completed)
                return Result::failure(blocker_error(completed.error(), "resume"));
        }
        return resumed;
    }

    [[nodiscard]] core::Result<void, script::ScriptError>
    cancel(const core::FlowFrameId& owner, const core::ScriptInvocationHandle& invocation)
    {
        auto valid = m_flow.validate_blocker(owner, invocation);
        if (!valid)
            return core::Result<void, script::ScriptError>::failure(
                blocker_error(valid.error(), "cancel"));
        m_runtime.cancel(invocation, runtime::ScriptCancellationReason::OwnerEnded);
        auto released = m_flow.cancel_blocker(owner, invocation);
        return released ? core::Result<void, script::ScriptError>::success()
                        : core::Result<void, script::ScriptError>::failure(
                              blocker_error(released.error(), "cancel"));
    }

    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, script::ScriptError>
    execute(std::string_view source, std::string_view chunk_name)
    {
        return invoke_immediate(source, chunk_name, runtime::ScriptInvocationResultKind::None,
                                m_gameplay);
    }

private:
    [[nodiscard]] core::Result<runtime::ScriptInvocationOutcome, script::ScriptError>
    invoke_immediate(std::string_view source, std::string_view chunk_name,
                     runtime::ScriptInvocationResultKind result_kind,
                     const runtime::RuntimeCapabilitySet& capabilities)
    {
        return m_runtime.invoke(
            runtime::ScriptInvocationRequest{.source = std::string(source),
                                             .chunk_name = std::string(chunk_name),
                                             .owner = std::nullopt,
                                             .invocation = std::nullopt,
                                             .source_context = m_gateway.current_source_context(),
                                             .result_kind = result_kind},
            capabilities);
    }

    script::ScriptRuntime& m_runtime;
    core::FlowExecutor& m_flow;
    runtime::RuntimeWorld m_world;
    runtime::RuntimeCommandGateway m_gateway;
    runtime::RuntimeCapabilitySet m_gameplay;
    runtime::RuntimeCapabilitySet m_expression;
};

} // namespace

TEST_CASE("ScriptRuntime initializes with pinned Lua and sol2 versions")
{
    RuntimeFixture fixture;
    auto initialized = fixture.runtime.initialize({&fixture.sources});
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
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    REQUIRE(fixture.runtime.execute("count = 1", "first"));
    REQUIRE(fixture.runtime.execute("count = count + 1", "second"));
    auto result = fixture.runtime.evaluate("count", "count");
    REQUIRE(result);
    REQUIRE(std::holds_alternative<std::int64_t>(result.value()));
    CHECK(std::get<std::int64_t>(result.value()) == 2);
}

TEST_CASE("ScriptRuntime focused environments isolate globals tables and load")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto first = fixture.runtime.create_environment();
    auto second = fixture.runtime.create_environment();
    REQUIRE(first);
    REQUIRE(second);

    REQUIRE(fixture.runtime.execute_in_environment(
        first.value(),
        "focused_value = 'first'; math.focused_marker = 'first'; "
        "local f = assert(load('loaded_value = _G.focused_value')); f()",
        "focused-first"));
    REQUIRE(fixture.runtime.execute_in_environment(second.value(), "focused_value = 'second'",
                                                   "focused-second"));

    auto first_value = fixture.runtime.evaluate_string_in_environment(
        first.value(), "focused_value .. ':' .. loaded_value .. ':' .. math.focused_marker",
        "focused-first-value");
    REQUIRE(first_value);
    CHECK(first_value.value() == "first:first:first");
    auto second_value = fixture.runtime.evaluate_string_in_environment(
        second.value(), "focused_value .. ':' .. tostring(math.focused_marker)",
        "focused-second-value");
    REQUIRE(second_value);
    CHECK(second_value.value() == "second:nil");
    auto global = fixture.runtime.evaluate("focused_value", "global-focused-value");
    REQUIRE(global);
    CHECK(std::holds_alternative<std::monostate>(global.value()));

    auto foreign_load = fixture.runtime.execute_in_environment(
        first.value(), "assert(load('return true', 'foreign', 't', {}))", "foreign-load");
    REQUIRE_FALSE(foreign_load);
    CHECK(foreign_load.error().message.find("foreign environment") != std::string::npos);

    fixture.runtime.destroy_environment(first.value());
    CHECK_FALSE(fixture.runtime.execute_in_environment(first.value(), "x = 1", "stale"));
    fixture.runtime.destroy_environment(second.value());
}

TEST_CASE("ScriptRuntime failed focused execution cannot leak globals")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto failed = fixture.runtime.create_environment();
    auto replacement = fixture.runtime.create_environment();
    REQUIRE(failed);
    REQUIRE(replacement);
    auto result = fixture.runtime.execute_in_environment(
        failed.value(), "candidate_global = 'leak'; error('candidate failed')", "failed-candidate");
    REQUIRE_FALSE(result);
    fixture.runtime.destroy_environment(failed.value());
    auto absent = fixture.runtime.evaluate_string_in_environment(
        replacement.value(), "tostring(candidate_global)", "replacement-candidate");
    REQUIRE(absent);
    CHECK(absent.value() == "nil");
    fixture.runtime.destroy_environment(replacement.value());
}

TEST_CASE("ScriptRuntime active focused environment retains RML script and event globals")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto environment = fixture.runtime.create_environment();
    REQUIRE(environment);

    {
        auto activation = fixture.runtime.activate_environment(environment.value());
        REQUIRE(activation);
        REQUIRE(fixture.runtime.execute(
            "inline_value = 'inline'; function focused_handler() event_value = inline_value end",
            "focused-inline-script"));
        REQUIRE(fixture.runtime.execute("external_value = inline_value .. ':external'",
                                        "focused-external-script"));
        REQUIRE(fixture.runtime.execute("template_value = external_value .. ':template'",
                                        "focused-template-script"));
        REQUIRE(fixture.runtime.execute("focused_handler()", "focused-event-handler"));
    }

    auto value = fixture.runtime.evaluate_string_in_environment(
        environment.value(), "event_value .. ':' .. template_value", "focused-event-result");
    REQUIRE(value);
    CHECK(value.value() == "inline:inline:external:template");
    auto global = fixture.runtime.evaluate("event_value", "global-event-result");
    REQUIRE(global);
    CHECK(std::holds_alternative<std::monostate>(global.value()));
    fixture.runtime.destroy_environment(environment.value());
}

TEST_CASE("Runtime and focused query providers produce equivalent condition and text results")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor flow(project, state);
    ScriptInvocationHarness runtime_invoker(fixture.runtime, project, state, flow);

    const auto generation = *runtime::CapabilityGeneration::from_number(2);
    FocusedCountQueryProvider focused_provider(generation);
    runtime::RuntimeCapabilityIssuer focused_issuer(focused_provider, generation);
    auto focused_capabilities =
        focused_issuer.issue(runtime::RuntimeCapabilityProfile::SynchronousExpression);
    REQUIRE(focused_capabilities);
    auto environment = fixture.runtime.create_environment();
    REQUIRE(environment);

    const core::LuaPredicate condition{"Game.prop('count') == 0"};
    const core::LuaTextExpression text{"'count=' .. Game.prop('count')"};
    auto runtime_condition = runtime_invoker.evaluate(condition);
    auto runtime_text = runtime_invoker.resolve(text);
    REQUIRE(runtime_condition);
    REQUIRE(runtime_text);

    auto focused_condition = fixture.runtime.invoke_in_environment(
        environment.value(),
        {.source = condition.source,
         .chunk_name = "focused-equivalent-condition",
         .owner = std::nullopt,
         .invocation = std::nullopt,
         .source_context = {},
         .result_kind = runtime::ScriptInvocationResultKind::Boolean,
         .asset_path = std::nullopt},
        *focused_capabilities);
    auto focused_text = fixture.runtime.invoke_in_environment(
        environment.value(),
        {.source = text.source,
         .chunk_name = "focused-equivalent-text",
         .owner = std::nullopt,
         .invocation = std::nullopt,
         .source_context = {},
         .result_kind = runtime::ScriptInvocationResultKind::String,
         .asset_path = std::nullopt},
        *focused_capabilities);
    REQUIRE(focused_condition);
    REQUIRE(focused_text);
    const auto* focused_condition_completed =
        std::get_if<runtime::ScriptInvocationCompleted>(focused_condition.value_if());
    const auto* focused_text_completed =
        std::get_if<runtime::ScriptInvocationCompleted>(focused_text.value_if());
    REQUIRE(focused_condition_completed != nullptr);
    REQUIRE(focused_text_completed != nullptr);
    CHECK(std::get<bool>(focused_condition_completed->value) == runtime_condition.value());
    CHECK(std::get<std::string>(focused_text_completed->value) == runtime_text.value());

    auto unadmitted = fixture.runtime.invoke_in_environment(
        environment.value(),
        {.source = "assert(Game.prop('secret'))",
         .chunk_name = "focused-unadmitted-query",
         .owner = std::nullopt,
         .invocation = std::nullopt,
         .source_context = {},
         .result_kind = runtime::ScriptInvocationResultKind::Boolean,
         .asset_path = std::nullopt},
        *focused_capabilities);
    REQUIRE_FALSE(unadmitted);
    fixture.runtime.destroy_environment(environment.value());
}

TEST_CASE("ScriptRuntime evaluates typed basic values")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    auto boolean = fixture.runtime.evaluate_bool("3 < 4", "bool");
    REQUIRE(boolean);
    CHECK(boolean.value());

    auto string = fixture.runtime.evaluate_string("'Novel' .. 'Tea'", "string");
    REQUIRE(string);
    CHECK(string.value() == "NovelTea");

    auto integer = fixture.runtime.evaluate("42", "integer");
    REQUIRE(integer);
    CHECK(std::holds_alternative<std::int64_t>(integer.value()));
    CHECK(std::get<std::int64_t>(integer.value()) == 42);

    auto whole_float = fixture.runtime.evaluate("42.0", "whole_float");
    REQUIRE(whole_float);
    CHECK(std::holds_alternative<double>(whole_float.value()));
    CHECK(std::get<double>(whole_float.value()) == 42.0);

    auto floating = fixture.runtime.evaluate("42.5", "float");
    REQUIRE(floating);
    CHECK(std::holds_alternative<double>(floating.value()));
    CHECK(std::get<double>(floating.value()) == 42.5);

    auto nil = fixture.runtime.evaluate("nil", "nil");
    REQUIRE(nil);
    CHECK(std::holds_alternative<std::monostate>(nil.value()));
}

TEST_CASE("ScriptRuntime has an explicit expression return policy")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    auto no_return = fixture.runtime.evaluate("print('no-return')", "no_return");
    REQUIRE(no_return);
    CHECK(std::holds_alternative<std::monostate>(no_return.value()));

    auto multiple = fixture.runtime.evaluate("1, 2", "multiple");
    REQUIRE_FALSE(multiple);
    CHECK(multiple.error().message.find("multiple values") != std::string::npos);

    for (const auto* expression : {"{}", "function() end", "coroutine.create(function() end)"}) {
        auto result = fixture.runtime.evaluate(expression, expression);
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("unsupported Lua result type") != std::string::npos);
    }

    lua_State* state = script::detail::ScriptRuntimeAccess::state(fixture.runtime);
    REQUIRE(state != nullptr);
    lua_pushlightuserdata(state, &fixture);
    lua_setglobal(state, "test_userdata");
    auto userdata = fixture.runtime.evaluate("test_userdata", "userdata");
    REQUIRE_FALSE(userdata);
    CHECK(userdata.error().message.find("userdata") != std::string::npos);
}

TEST_CASE("ScriptRuntime reports syntax errors and nested runtime tracebacks")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    auto syntax = fixture.runtime.execute("function bad(", "bad_syntax");
    REQUIRE_FALSE(syntax);
    CHECK(syntax.error().code == script::ScriptErrorCode::LoadFailed);
    CHECK(syntax.error().chunk.find("bad_syntax") != std::string::npos);
    CHECK_FALSE(syntax.error().message.empty());
    CHECK_FALSE(syntax.error().traceback.empty());

    auto runtime = fixture.runtime.execute("error('boom')", "bad_runtime");
    REQUIRE_FALSE(runtime);
    CHECK(runtime.error().code == script::ScriptErrorCode::RuntimeFailed);
    CHECK(runtime.error().message.find("boom") != std::string::npos);
    CHECK(runtime.error().traceback.find("boom") != std::string::npos);
    CHECK(runtime.error().traceback.find("stack traceback") != std::string::npos);

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
    CHECK(nested.error().message.find("boom") != std::string::npos);
    CHECK(nested.error().chunk.find("nested_runtime") != std::string::npos);
    CHECK(nested.error().traceback.find("boom") != std::string::npos);
    CHECK(nested.error().traceback.find("nested_runtime") != std::string::npos);
    CHECK(nested.error().traceback.find("deepest") != std::string::npos);
    CHECK(nested.error().traceback.find("middle") != std::string::npos);
    CHECK(nested.error().traceback != nested.error().message);
}

TEST_CASE("ScriptRuntime handles coroutine yield and resume through Lua status codes")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    auto result = fixture.runtime.execute(R"(
        local co = coroutine.create(function()
            local resumed = coroutine.yield("paused")
            return resumed
        end)
        local ok1, first = coroutine.resume(co)
        assert(ok1 and first == "paused")
        local ok2, second = coroutine.resume(co, "finished")
        assert(ok2 and second == "finished")
        assert(coroutine.status(co) == "dead")
    )",
                                          "coroutine_status");
    REQUIRE(result);
}

TEST_CASE("ScriptRuntime rejects yields from immediate expression invocation forms")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto immediate_condition = invoker.evaluate(core::LuaPredicate{"2 + 2 == 4"});
    REQUIRE(immediate_condition);
    CHECK(immediate_condition.value());
    auto immediate_text = invoker.resolve(core::LuaTextExpression{"'typed text'"});
    REQUIRE(immediate_text);
    CHECK(immediate_text.value() == "typed text");

    auto condition = invoker.evaluate(core::LuaPredicate{"coroutine.yield()"});
    REQUIRE_FALSE(condition);
    CHECK(condition.error().code == script::ScriptErrorCode::YieldForbidden);

    auto text = invoker.resolve(core::LuaTextExpression{"coroutine.yield()"});
    REQUIRE_FALSE(text);
    CHECK(text.error().code == script::ScriptErrorCode::YieldForbidden);
}

TEST_CASE("Project Script Modules cache exports and Bootstrap uses controlled imports")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project_with_modules({
        {"shared", "return { value = 41 }"},
        {"bootstrap",
         "local first = import('shared')\nlocal second = import('shared')\n"
         "assert(first == second)\nassert(import('shared', 'value') == 41)\nreturn {}"},
    });

    REQUIRE(fixture.runtime.prepare_project_modules(project));
    REQUIRE(fixture.runtime.run_project_bootstrap());
}

TEST_CASE("Project Script Module imports reject cycles missing modules exports and failed retries")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    SECTION("cycle")
    {
        auto project = load_script_project_with_modules(
            {
                {"a", "import('b')\nreturn {}"},
                {"b", "import('a')\nreturn {}"},
            },
            "a");
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        auto result = fixture.runtime.run_project_bootstrap();
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("cycle") != std::string::npos);
    }

    SECTION("missing module")
    {
        auto project =
            load_script_project_with_modules({{"bootstrap", "import('missing')\nreturn {}"}});
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        auto result = fixture.runtime.run_project_bootstrap();
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("does not exist") != std::string::npos);
    }

    SECTION("missing export")
    {
        auto project = load_script_project_with_modules({
            {"shared", "return { present = true }"},
            {"bootstrap", "import('shared', 'missing')\nreturn {}"},
        });
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        auto result = fixture.runtime.run_project_bootstrap();
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("has no export") != std::string::npos);
    }

    SECTION("failed module is not retried")
    {
        auto project = load_script_project_with_modules({
            {"broken", "error('initialization failed')"},
            {"bootstrap",
             "local ok = pcall(import, 'broken')\nassert(not ok)\nimport('broken')\nreturn {}"},
        });
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        auto result = fixture.runtime.run_project_bootstrap();
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("previously failed initialization") != std::string::npos);
    }
}

TEST_CASE("On Game Ready runs loaded module handlers dependency-first with read-only live state")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project_with_modules({
        {"order", "return { value = '' }"},
        {"a", "local order = import('order')\n"
              "local retained_room = nil\n"
              "return { on_ready = function()\n"
              "  retained_room = retained_room or select(1, noveltea.project.room('start'))\n"
              "  assert(retained_room.kind == 'room' and retained_room.id == 'start')\n"
              "  local mood, present, err = retained_room:prop('mood')\n"
              "  assert(err == nil and present and mood == 'calm')\n"
              "  local ok, write_err = retained_room:set_prop('mood', 'tense')\n"
              "  assert(not ok and type(write_err) == 'string')\n"
              "  order.value = order.value .. 'a'\n"
              "end }"},
        {"z", "local order = import('order')\n"
              "return { on_ready = function()\n"
              "  assert(order.value == 'a')\n"
              "  order.value = order.value .. 'z'\n"
              "end }"},
        {"bootstrap", "import('z')\nimport('a')\nreturn {}"},
    });
    REQUIRE(fixture.runtime.prepare_project_modules(project));
    REQUIRE(fixture.runtime.run_project_bootstrap());

    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    runtime::RuntimeWorld world(project, state);
    runtime::RuntimeCommandGateway gateway(project, state, world,
                                           *runtime::CapabilityGeneration::from_number(1));
    auto ready = issue_capabilities(gateway, runtime::RuntimeCapabilityProfile::OnGameReady);

    auto result = fixture.runtime.run_project_on_game_ready(ready);
    INFO((result ? std::string{} : result.error().message + " | " + result.error().traceback));
    REQUIRE(result);
    CHECK(gateway.command_queue().empty());
}

TEST_CASE("On Game Ready rejects yielding handlers invalid exports and late module initialization")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    const auto run = [&](std::initializer_list<std::pair<std::string, std::string>> modules) {
        auto project = load_script_project_with_modules(modules);
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        REQUIRE(fixture.runtime.run_project_bootstrap());
        auto state_result = core::SessionState::create(project);
        REQUIRE(state_result);
        auto state = std::move(state_result).value();
        runtime::RuntimeWorld world(project, state);
        runtime::RuntimeCommandGateway gateway(project, state, world,
                                               *runtime::CapabilityGeneration::from_number(1));
        auto ready = issue_capabilities(gateway, runtime::RuntimeCapabilityProfile::OnGameReady);
        return fixture.runtime.run_project_on_game_ready(ready);
    };

    SECTION("yield")
    {
        auto result = run({{"ready", "return { on_ready = function() coroutine.yield() end }"},
                           {"bootstrap", "import('ready')\nreturn {}"}});
        REQUIRE_FALSE(result);
        CHECK((result.error().code == script::ScriptErrorCode::YieldForbidden ||
               result.error().message.find("yield") != std::string::npos));
    }

    SECTION("invalid export")
    {
        auto result = run(
            {{"ready", "return { on_ready = true }"}, {"bootstrap", "import('ready')\nreturn {}"}});
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("must be a function") != std::string::npos);
    }

    SECTION("late import")
    {
        auto result = run({{"late", "return {}"},
                           {"ready", "return { on_ready = function() import('late') end }"},
                           {"bootstrap", "import('ready')\nreturn {}"}});
        REQUIRE_FALSE(result);
        CHECK(result.error().message.find("during Bootstrap") != std::string::npos);
    }
}

TEST_CASE("Project Bootstrap and module initialization cannot yield or use gameplay capabilities")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));

    SECTION("yield")
    {
        auto project =
            load_script_project_with_modules({{"bootstrap", "coroutine.yield()\nreturn {}"}});
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        auto result = fixture.runtime.run_project_bootstrap();
        REQUIRE_FALSE(result);
        CHECK((result.error().code == script::ScriptErrorCode::YieldForbidden ||
               result.error().message.find("yield") != std::string::npos));
    }

    SECTION("gameplay state")
    {
        auto project = load_script_project_with_modules(
            {{"bootstrap",
              "local value, err = Game.prop('count')\nassert(value == nil and err)\nreturn {}"}});
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        REQUIRE(fixture.runtime.run_project_bootstrap());
    }

    SECTION("unrestricted loaders remain unavailable")
    {
        auto project = load_script_project_with_modules({
            {"bootstrap",
             "assert(package == nil and require == nil and io == nil and os == nil)\nreturn {}"},
        });
        REQUIRE(fixture.runtime.prepare_project_modules(project));
        REQUIRE(fixture.runtime.run_project_bootstrap());
    }
}

TEST_CASE("script invocation port suspends and resumes only its exact flow frame and invocation")
{
    static_assert(
        !std::is_convertible_v<core::PresentationFlowBlockerHandle, core::ScriptInvocationHandle>);

    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto started = invoker.invoke(
        core::RunLuaEffect{"coroutine.yield(); invocation_completed = true"}, "effect-suspension");
    REQUIRE(started);
    const auto* suspended = std::get_if<script::ScriptInvocationSuspended>(&started.value());
    REQUIRE(suspended != nullptr);
    REQUIRE(state.blocker());
    CHECK(std::holds_alternative<core::ScriptFlowBlocker>(*state.blocker()));
    CHECK(core::flow_blocker_owner(*state.blocker()) == suspended->owner);
    CHECK(core::flow_blocker_handle(*state.blocker()) ==
          core::AnyFlowBlockerHandle{suspended->invocation});

    auto resumed = invoker.resume(suspended->owner, suspended->invocation);
    REQUIRE(resumed);
    CHECK(std::holds_alternative<script::ScriptInvocationCompleted>(resumed.value()));
    CHECK_FALSE(state.blocker());
    auto completed = fixture.runtime.evaluate_bool("invocation_completed", "completed");
    REQUIRE(completed);
    CHECK(completed.value());

    auto duplicate = invoker.resume(suspended->owner, suspended->invocation);
    REQUIRE_FALSE(duplicate);
    CHECK(duplicate.error().code == script::ScriptErrorCode::StaleInvocation);
}

TEST_CASE("script invocation port validates frame ownership and supports exact cancellation")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto first =
        invoker.invoke("coroutine.yield(); cancelled_continued = true", "cancelled-effect");
    REQUIRE(first);
    const auto cancelled = std::get<script::ScriptInvocationSuspended>(first.value());
    REQUIRE(invoker.cancel(cancelled.owner, cancelled.invocation));
    CHECK_FALSE(state.blocker());
    auto did_not_continue =
        fixture.runtime.evaluate_bool("cancelled_continued == nil", "cancel-check");
    REQUIRE(did_not_continue);
    CHECK(did_not_continue.value());
    auto duplicate_cancel = invoker.cancel(cancelled.owner, cancelled.invocation);
    REQUIRE_FALSE(duplicate_cancel);
    CHECK(duplicate_cancel.error().code == script::ScriptErrorCode::StaleInvocation);

    auto target = core::SceneId::create("opening");
    REQUIRE(target);
    REQUIRE(executor.apply_target(target.value()));
    auto second = invoker.invoke("coroutine.yield(); owner_checked = true", "owned-effect");
    REQUIRE(second);
    const auto active = std::get<script::ScriptInvocationSuspended>(second.value());
    CHECK(active.owner != cancelled.owner);

    auto wrong_owner = invoker.resume(cancelled.owner, active.invocation);
    REQUIRE_FALSE(wrong_owner);
    CHECK(wrong_owner.error().code == script::ScriptErrorCode::StaleInvocation);
    REQUIRE(state.blocker());

    auto exact = invoker.resume(active.owner, active.invocation);
    REQUIRE(exact);
    CHECK(std::holds_alternative<script::ScriptInvocationCompleted>(exact.value()));
    CHECK_FALSE(state.blocker());
}

TEST_CASE("script invocation port preserves the exact capability profile across suspension")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto started =
        invoker.invoke("coroutine.yield(); exact_profile_resumed = true", "exact-profile-effect");
    REQUIRE(started);
    const auto suspended = std::get<script::ScriptInvocationSuspended>(started.value());

    auto wrong_profile =
        fixture.runtime.resume(suspended.invocation, invoker.expression_capabilities());
    REQUIRE_FALSE(wrong_profile);
    CHECK(wrong_profile.error().code == script::ScriptErrorCode::StaleInvocation);
    REQUIRE(state.blocker());
    auto not_resumed =
        fixture.runtime.evaluate_bool("exact_profile_resumed == nil", "exact-profile-not-resumed");
    REQUIRE(not_resumed);
    CHECK(not_resumed.value());

    runtime::RuntimeCapabilityIssuer next_generation_issuer(
        invoker.gateway(),
        *runtime::CapabilityGeneration::from_number(invoker.gateway().generation().number() + 1));
    auto wrong_generation =
        next_generation_issuer.issue(runtime::RuntimeCapabilityProfile::GameplayScript);
    REQUIRE(wrong_generation.has_value());
    auto stale_generation = fixture.runtime.resume(suspended.invocation, *wrong_generation);
    REQUIRE_FALSE(stale_generation);
    CHECK(stale_generation.error().code == script::ScriptErrorCode::StaleInvocation);
    REQUIRE(state.blocker());

    auto resumed = invoker.resume(suspended.owner, suspended.invocation);
    REQUIRE(resumed);
    CHECK(std::holds_alternative<script::ScriptInvocationCompleted>(resumed.value()));
    CHECK_FALSE(state.blocker());
}

TEST_CASE("non-yielding capability profiles reject yield-capable invocation")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto allocated = executor.block_top(core::FlowBlockerKind::Script);
    REQUIRE(allocated);
    const auto* blocker = std::get_if<core::ScriptFlowBlocker>(allocated.value_if());
    REQUIRE(blocker != nullptr);
    auto rejected = fixture.runtime.invoke(
        runtime::ScriptInvocationRequest{.source = "coroutine.yield()",
                                         .chunk_name = "expression-yield",
                                         .owner = blocker->owner,
                                         .invocation = blocker->handle,
                                         .source_context =
                                             invoker.gateway().current_source_context(),
                                         .result_kind = runtime::ScriptInvocationResultKind::None},
        invoker.expression_capabilities());
    REQUIRE_FALSE(rejected);
    CHECK(rejected.error().code == script::ScriptErrorCode::YieldForbidden);

    REQUIRE(executor.cancel_blocker(blocker->owner, blocker->handle));
    auto stale = fixture.runtime.resume(blocker->handle, invoker.expression_capabilities());
    REQUIRE_FALSE(stale);
    CHECK(stale.error().code == script::ScriptErrorCode::StaleInvocation);
}

TEST_CASE("script invocation port propagates nested failures after suspension")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto started = invoker.invoke(R"(
        local function nested_failure()
            error("nested resume boom")
        end
        coroutine.yield()
        nested_failure()
    )",
                                  "nested-effect");
    REQUIRE(started);
    const auto suspended = std::get<script::ScriptInvocationSuspended>(started.value());
    auto resumed = invoker.resume(suspended.owner, suspended.invocation);
    REQUIRE_FALSE(resumed);
    CHECK(resumed.error().code == script::ScriptErrorCode::RuntimeFailed);
    CHECK(resumed.error().message.find("nested resume boom") != std::string::npos);
    CHECK(resumed.error().traceback.find("nested_failure") != std::string::npos);
    CHECK_FALSE(state.blocker());
}

TEST_CASE("typed Lua host services expose validated state and closed requests only")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);

    auto executed = invoker.execute(R"(
        assert(type(Game) == "table" and Save == nil and Script == nil)
        assert(type(Game.continue) == "function" and type(Game.save) == "function")
        assert(prop == nil and set_prop == nil and thisEntity == nil)

        local scene, scene_error = noveltea.project.scene("opening")
        assert(scene_error == nil and scene.id == "opening" and scene.display_name == "Opening")
        local room, room_error = noveltea.project.room("hall")
        assert(room_error == nil and room.kind == "room" and room.id == "hall")
        local identity_mood, identity_present, identity_error = room:prop("mood")
        assert(identity_error == nil and identity_present and identity_mood == "tense")
        local character, character_error = noveltea.project.character("hero")
        assert(character_error == nil and character.kind == "character" and character.id == "hero")
        local character_location, character_location_error = character:location()
        assert(character_location_error == nil and character_location.kind == "room")
        local interactable, interactable_error = noveltea.project.interactable("key")
        assert(interactable_error == nil and interactable.kind == "interactable" and interactable.id == "key")
        local interactable_location, interactable_location_error = interactable:location()
        assert(interactable_location_error == nil and interactable_location.kind == "room")
        local missing, missing_error = noveltea.project.room("missing")
        assert(missing == nil and type(missing_error) == "string")

        local count, count_error = Game.prop("count")
        assert(count_error == nil and count == 2)
        local ok, error_message = Game.set_prop("count", 7)
        assert(ok and error_message == nil)
        ok, error_message = Game.set_prop("count", "seven")
        assert(not ok and type(error_message) == "string")
        ok, error_message = Game.set_prop("missing", 1)
        assert(not ok and type(error_message) == "string")
        ok, error_message = Game.set_prop("count", {})
        assert(not ok and type(error_message) == "string")
        ok, error_message = Game.set_prop("ratio", math.huge)
        assert(not ok and type(error_message) == "string")

        local mood, present, property_error = noveltea.properties.get("room", "hall", "mood")
        assert(property_error == nil and present and mood == "tense")
        ok, error_message = noveltea.properties.set("room", "hall", "mood", "calm")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.properties.set("room", "hall", "mood", "invalid")
        assert(not ok and type(error_message) == "string")
        ok, error_message = noveltea.properties.set("scene", "opening", "mood", "calm")
        assert(not ok and type(error_message) == "string")
        ok, error_message = noveltea.properties.set("room", "hall", "mood", nil)
        assert(not ok and type(error_message) == "string")
        ok, error_message = noveltea.properties.unset("room", "hall", "mood")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.properties.set("dialogue", "intro", "note", nil)
        assert(not ok and type(error_message) == "string")
        mood, present, property_error = noveltea.properties.get("unknown", "hall", "mood")
        assert(not present and type(property_error) == "string")

        local location, location_error = noveltea.interactables.location("coin")
        assert(location_error == nil and location.kind == "unplaced")
        location, location_error = noveltea.interactables.location("key")
        assert(location_error == nil and location.kind == "room" and location.room == "start")
        ok, error_message = noveltea.interactables.set_location("key", {
            kind = "inventory",
            inventory = { owner = { kind = "project" }, id = "player" }
        })
        assert(ok and error_message == nil)
        ok, error_message = noveltea.interactables.set_location("dust", { kind = "unplaced" })
        assert(ok and error_message == nil)
        ok, error_message = noveltea.interactables.set_location(
            "key", { kind = "room", room = "start" })
        assert(ok and error_message == nil)
        ok, error_message = noveltea.interactables.set_location(
            "key", { kind = "room", room = "hall" })
        assert(ok and error_message == nil)

        ok, error_message = noveltea.flow.call_scene("closing")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.call_dialogue("intro")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.replace_scene("closing")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.replace_dialogue("intro")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.replace_room("hall")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.return_to_caller()
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.end_flow()
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.start_transient_scene("closing")
        assert(not ok and type(error_message) == "string")
        ok, error_message = noveltea.navigation.via_exit("start", "north-exit")
        assert(not ok and type(error_message) == "string")
        ok, error_message = noveltea.notify("Found the key")
        assert(ok and error_message == nil)
    )",
                                    "typed-host");
    const std::string execution_error =
        executed ? std::string{} : executed.error().message + " | " + executed.error().traceback;
    INFO(execution_error);
    REQUIRE(executed);

    REQUIRE(invoker.gateway().global_property(core::PropertyId::create("count").value()).value() ==
            core::RuntimeValue{std::int64_t{7}});
    std::vector<runtime::DeferredRuntimeCommand> commands;
    while (auto command = invoker.gateway().command_queue().pop_front())
        commands.push_back(std::move(*command));
    REQUIRE(commands.size() == 11);
    CHECK(is_runtime_command<runtime::SetInteractableWorldStateCommand>(commands[0]));
    CHECK(is_runtime_command<runtime::SetInteractableWorldStateCommand>(commands[1]));
    CHECK(is_runtime_command<runtime::SetInteractableWorldStateCommand>(commands[2]));
    CHECK(is_runtime_command<runtime::SetInteractableWorldStateCommand>(commands[3]));
    CHECK(is_runtime_command<runtime::CallChildSceneCommand>(commands[4]));
    CHECK(is_runtime_command<runtime::CallChildDialogueCommand>(commands[5]));
    CHECK(is_runtime_command<runtime::TailReplaceFlowCommand>(commands[6]));
    CHECK(is_runtime_command<runtime::TailReplaceFlowCommand>(commands[7]));
    CHECK(is_runtime_command<runtime::TailReplaceFlowCommand>(commands[8]));
    CHECK(is_runtime_command<runtime::TailReplaceFlowCommand>(commands[9]));
    CHECK(is_runtime_command<runtime::TailReplaceFlowCommand>(commands[10]));
    auto events = invoker.gateway().take_events();
    REQUIRE(events.size() == 1);
    CHECK(std::holds_alternative<runtime::NotificationEvent>(events.front()));
    CHECK(invoker.gateway().command_queue().empty());
    CHECK(invoker.gateway().events().empty());
}

TEST_CASE("typed Lua host services distinguish Room transient and navigation requests")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_compiled_fixture("comprehensive.json");
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor executor(project, state);

    REQUIRE(executor.advance_room_transition(core::RoomTransitionStage::BeforeEnter));
    REQUIRE(executor.advance_room_transition(core::RoomTransitionStage::BeforeEnter, 1));
    REQUIRE(executor.advance_room_transition(core::RoomTransitionStage::CommitRoomSwitch));
    REQUIRE(executor.advance_room_transition(core::RoomTransitionStage::AfterEnter));
    REQUIRE(executor.advance_room_transition(core::RoomTransitionStage::AfterEnter, 1));
    REQUIRE(executor.advance_room_transition(core::RoomTransitionStage::Complete));
    REQUIRE(executor.complete_room_transition());

    ScriptInvocationHarness invoker(fixture.runtime, project, state, executor);
    REQUIRE(invoker.execute(R"(
        local ok, error_message = noveltea.flow.start_transient_scene("opening")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.start_transient_dialogue("intro")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.navigation.via_exit("start", "north-exit")
        assert(ok and error_message == nil)
        ok, error_message = noveltea.flow.call_scene("opening")
        assert(not ok and type(error_message) == "string")
        ok, error_message = noveltea.flow.replace_scene("opening")
        assert(not ok and type(error_message) == "string")
    )",
                            "typed-room-host"));

    REQUIRE(invoker.gateway().command_queue().size() == 3);
    auto scene = invoker.gateway().command_queue().pop_front();
    auto dialogue = invoker.gateway().command_queue().pop_front();
    auto navigation = invoker.gateway().command_queue().pop_front();
    REQUIRE(scene.has_value());
    REQUIRE(dialogue.has_value());
    REQUIRE(navigation.has_value());
    CHECK(std::holds_alternative<runtime::StartTransientSceneCommand>(scene->payload));
    CHECK(std::holds_alternative<runtime::StartTransientDialogueCommand>(dialogue->payload));
    const auto* command = std::get_if<runtime::NavigateRoomCommand>(&navigation->payload);
    REQUIRE(command != nullptr);
    CHECK(command->target == core::RoomId::create("hall").value());
}

TEST_CASE("runtime script API enforces capability profiles and stale generations")
{
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    runtime::RuntimeWorld world(project, state);
    runtime::RuntimeCommandGateway gateway(project, state, world,
                                           *runtime::CapabilityGeneration::from_number(1));
    runtime::RuntimeCapabilityIssuer issuer(gateway, gateway.generation());
    auto expression = issuer.issue(runtime::RuntimeCapabilityProfile::SynchronousExpression);
    REQUIRE(expression.has_value());

    script::RuntimeScriptApi api;
    api.replace_capabilities(*expression);
    const auto count = core::PropertyId::create("count").value();
    REQUIRE(api.global_property(count));

    auto denied = api.set_global_property(count, std::int64_t{9});
    REQUIRE_FALSE(denied);
    REQUIRE_FALSE(denied.error().empty());
    CHECK(denied.error().front().code == "runtime.script_capability_denied");

    gateway.invalidate();
    auto stale = api.global_property(count);
    REQUIRE_FALSE(stale);
    REQUIRE_FALSE(stale.error().empty());
    CHECK(stale.error().front().code == "runtime.script_capability_stale");
}

TEST_CASE("script invocation capabilities are scoped to the active frontend call")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto project = load_script_project();
    auto state_result = core::SessionState::create(project);
    REQUIRE(state_result);
    auto state = std::move(state_result).value();
    core::FlowExecutor flow(project, state);
    ScriptInvocationHarness invoker(fixture.runtime, project, state, flow);

    auto evaluated = invoker.evaluate(core::LuaPredicate{"Game.prop('count') == 0"});
    REQUIRE(evaluated);

    REQUIRE(invoker.execute(
        "retained_room = select(1, noveltea.project.room('hall')); "
        "assert(retained_room.kind == 'room' and retained_room.id == 'hall'); "
        "local ok, err = retained_room:set_prop('mood', 'calm'); assert(ok and err == nil)",
        "retain-gameplay-identity"));
    auto denied = invoker.evaluate(
        core::LuaPredicate{"(function() local ok, err = retained_room:set_prop('mood', 'tense'); "
                           "return not ok and type(err) == 'string' end)()"});
    REQUIRE(denied);
    CHECK(denied.value());

    auto escaped = fixture.runtime.execute(
        "local value, err = Game.prop('count'); "
        "assert(value == nil and type(err) == 'string'); "
        "local prop, present, prop_err = retained_room:prop('mood'); "
        "assert(prop == nil and not present and type(prop_err) == 'string')",
        "capability-after-return");
    REQUIRE(escaped);
}

TEST_CASE("ScriptRuntime does not expose unsafe standard libraries by default")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    for (const auto* name : {"os", "io", "debug", "package", "require", "dofile", "loadfile"}) {
        auto result = fixture.runtime.evaluate_bool(std::string(name) + " == nil", name);
        REQUIRE(result);
        CHECK(result.value());
    }
    auto load_available = fixture.runtime.evaluate_bool("load ~= nil", "load");
    REQUIRE(load_available);
    CHECK(load_available.value());
}

TEST_CASE("ScriptRuntime initialization failure leaves runtime clean")
{
    script::ScriptRuntime runtime;
    auto initialized = runtime.initialize({});
    REQUIRE_FALSE(initialized);
    CHECK_FALSE(runtime.is_initialized());
    runtime.shutdown();
    CHECK_FALSE(runtime.is_initialized());
}

TEST_CASE(
    "ScriptRuntime converts bound callback argument failures into diagnostics and stays usable")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    sol::state_view lua(script::detail::ScriptRuntimeAccess::state(fixture.runtime));
    lua.set_function("expects_string", [](std::string) {});
    auto failed = fixture.runtime.execute("expects_string({})", "callback_argument_error");
    REQUIRE_FALSE(failed);
    CHECK(failed.error().message.find("string") != std::string::npos);
    CHECK(failed.error().traceback.find("stack traceback") != std::string::npos);

    auto still_usable = fixture.runtime.evaluate_string("'still' .. '-ok'", "after_failure");
    REQUIRE(still_usable);
    CHECK(still_usable.value() == "still-ok");
}

TEST_CASE("ScriptRuntime exposes inert audio bindings without backend capture")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    REQUIRE(fixture.runtime.execute(
        "local ok, err = audio.play('missing', 'voice'); "
        "audio_inert = type(audio) == 'table' and not ok and type(err) == 'string'",
        "audio_backend_boundary"));
    auto inert = fixture.runtime.evaluate_bool("audio_inert", "audio_backend_boundary");
    REQUIRE(inert);
    CHECK(inert.value());
}

TEST_CASE("ScriptRuntime executes scripts through ScriptSourcePort logical paths")
{
    RuntimeFixture fixture;
    fixture.sources.add("project:/scripts/example.lua",
                        bytes("asset_value = noveltea.echo('asset-ok')"));
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    auto executed = fixture.runtime.execute_asset("project:/scripts/example.lua");
    REQUIRE(executed);
    auto value = fixture.runtime.evaluate_string("asset_value", "asset_value");
    REQUIRE(value);
    CHECK(value.value() == "asset-ok");
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
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
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
    CHECK(observed.value() == "kept:1");
    auto calls = fixture.runtime.evaluate("stored_object.calls", "calls");
    REQUIRE(calls);
    CHECK(std::get<std::int64_t>(calls.value()) == 1);

    REQUIRE(fixture.runtime.execute("test_object = nil\nstored_object = nil", "release"));
    fixture.runtime.collect_garbage();
    CHECK(weak.expired());
}

TEST_CASE("ScriptRuntime shutdown is idempotent and supports reinitialization")
{
    RuntimeFixture fixture;
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    fixture.runtime.shutdown();
    fixture.runtime.shutdown();
    CHECK_FALSE(fixture.runtime.is_initialized());
    REQUIRE(fixture.runtime.initialize({&fixture.sources}));
    CHECK(fixture.runtime.is_initialized());
}
