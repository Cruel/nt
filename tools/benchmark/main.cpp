#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/core/project_document.hpp>
#include <noveltea/core/runtime_project_codec.hpp>
#include <noveltea/script/script_runtime.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string_view>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;

struct Samples {
    std::vector<double> values_ms;

    [[nodiscard]] double median() const
    {
        auto sorted = values_ms;
        std::sort(sorted.begin(), sorted.end());
        const std::size_t middle = sorted.size() / 2;
        return sorted.size() % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) * 0.5
                                      : sorted[middle];
    }

    [[nodiscard]] double minimum() const
    {
        return *std::min_element(values_ms.begin(), values_ms.end());
    }
};

template<typename Function> Samples measure(std::size_t samples, Function&& function)
{
    Samples result;
    result.values_ms.reserve(samples);
    for (std::size_t i = 0; i < samples; ++i) {
        const auto started = Clock::now();
        function();
        const auto elapsed = std::chrono::duration<double, std::milli>(Clock::now() - started);
        result.values_ms.push_back(elapsed.count());
    }
    return result;
}

void print_metric(std::string_view name, std::size_t iterations, const Samples& samples)
{
    std::printf("{\"metric\":\"%.*s\",\"iterations\":%zu,\"samples\":%zu,"
                "\"median_ms\":%.6f,\"min_ms\":%.6f}\n",
                static_cast<int>(name.size()), name.data(), iterations, samples.values_ms.size(),
                samples.median(), samples.minimum());
}

std::size_t parse_count(const char* value, std::size_t fallback)
{
    if (!value)
        return fallback;
    char* end = nullptr;
    const unsigned long parsed = std::strtoul(value, &end, 10);
    return end && *end == '\0' && parsed > 0 ? static_cast<std::size_t>(parsed) : fallback;
}

} // namespace

int main(int argc, char** argv)
{
    const std::size_t iterations = parse_count(argc > 1 ? argv[1] : nullptr, 1000);
    const std::size_t samples = parse_count(argc > 2 ? argv[2] : nullptr, 11);

    const auto project_text = noveltea::core::ProjectDocument::new_project().dump();
    std::uint64_t json_guard = 0;
    const auto json_samples = measure(samples, [&] {
        for (std::size_t i = 0; i < iterations; ++i) {
            const auto parsed = nlohmann::json::parse(project_text, nullptr, false);
            if (parsed.is_discarded())
                std::abort();
            const auto decoded = noveltea::core::decode_runtime_project(parsed);
            json_guard += parsed.size() + (decoded ? 1U : 0U);
        }
    });
    print_metric("json_runtime_project", iterations, json_samples);

    const auto invalid_json_samples = measure(samples, [&] {
        for (std::size_t i = 0; i < iterations; ++i) {
            const auto parsed = nlohmann::json::parse("{\"rooms\":", nullptr, false);
            if (!parsed.is_discarded())
                std::abort();
        }
    });
    print_metric("json_invalid", iterations, invalid_json_samples);

    noveltea::assets::AssetManager assets;
    noveltea::script::ScriptRuntime runtime;
    const auto initialized = runtime.initialize({.assets = &assets});
    if (!initialized)
        return 2;
    const auto setup = runtime.execute("counter = 0", "benchmark_setup");
    if (!setup)
        return 3;

    std::uint64_t lua_guard = 0;
    const auto lua_samples = measure(samples, [&] {
        for (std::size_t i = 0; i < iterations; ++i) {
            const auto result = runtime.execute(
                "counter = counter + 1; local x = counter * 3; x = x / 2", "benchmark_lua");
            if (!result)
                std::abort();
            ++lua_guard;
        }
    });
    print_metric("lua_execute", iterations, lua_samples);

    const auto lua_error_samples = measure(samples, [&] {
        for (std::size_t i = 0; i < iterations; ++i) {
            const auto result =
                runtime.execute("error('benchmark failure')", "benchmark_lua_error");
            if (result)
                std::abort();
        }
    });
    print_metric("lua_protected_error", iterations, lua_error_samples);

    return json_guard == 0 || lua_guard == 0 ? 4 : 0;
}
