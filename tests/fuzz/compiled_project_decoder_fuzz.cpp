#include <noveltea/core/compiled_project_codec.hpp>

#include <cstddef>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <span>
#include <string>
#include <string_view>

#include <nlohmann/json.hpp>

namespace {

bool exercise_input(std::span<const std::uint8_t> bytes, std::string_view source_path)
{
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    const auto document = nlohmann::json::parse(text, nullptr, false);
    const auto result = noveltea::core::decode_compiled_project(document, std::string(source_path));
    return result.has_value() || !result.error().empty();
}

#if !defined(NOVELTEA_USE_LIBFUZZER)
bool exercise_fixture(std::string_view name)
{
    const std::string path = std::string(NOVELTEA_SOURCE_DIR) +
                             "/editor/src/renderer/test/fixtures/compiled-project-golden/" +
                             std::string(name) + ".json";
    std::ifstream stream(path, std::ios::binary);
    if (!stream.good())
        return false;

    const std::string text((std::istreambuf_iterator<char>(stream)),
                           std::istreambuf_iterator<char>());
    const auto document = nlohmann::json::parse(text, nullptr, false);
    if (document.is_discarded())
        return false;
    return noveltea::core::decode_compiled_project(document, path).has_value();
}
#endif

} // namespace

#if defined(NOVELTEA_USE_LIBFUZZER)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size)
{
    (void)exercise_input(std::span<const std::uint8_t>(data, size), "fuzz-input.json");
    return 0;
}
#else
int main()
{
    static constexpr std::string_view malformed_corpus[] = {
        "",
        "{",
        "[]",
        "null",
        "true",
        "{}",
        "{\"schema\":\"noveltea.runtime.project\"}",
        "{\"schema\":\"noveltea.compiled.project\",\"schemaVersion\":2}",
        "{\"schema\":\"noveltea.compiled.project\",\"schemaVersion\":1,\"future\":true}",
        "\xff\x00\xfe",
    };
    for (const auto input : malformed_corpus) {
        if (!exercise_input(std::span<const std::uint8_t>(
                                reinterpret_cast<const std::uint8_t*>(input.data()), input.size()),
                            "fuzz-smoke.json"))
            return 1;
    }

    for (const auto name :
         {"minimal", "comprehensive", "inheritance-properties-localization", "resources",
          "scene-program", "dialogue-program", "interaction-program"})
        if (!exercise_fixture(name))
            return 1;
    return 0;
}
#endif
