#include <noveltea/core/legacy/project_importer.hpp>
#include <noveltea/core/legacy/project_package_reader.hpp>
#include <noveltea/core/rich_text.hpp>
#include <noveltea/core/runtime_project_codec.hpp>
#include <noveltea/core/save_document.hpp>

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <nlohmann/json.hpp>

namespace {

void exercise_input(std::span<const std::uint8_t> bytes)
{
#if NOVELTEA_FUZZ_KIND == 1
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    std::vector<noveltea::core::legacy::ImportError> import_errors;
    (void)noveltea::core::legacy::ProjectImporter::import_game_json_text(text, import_errors);
    std::vector<noveltea::core::DocumentError> save_errors;
    (void)noveltea::core::SaveDocument::parse_json_text(text, save_errors);
#elif NOVELTEA_FUZZ_KIND == 2
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    const auto parsed = noveltea::core::parse_rich_text(text);
    (void)noveltea::core::strip_rich_text_tags(text);
    const auto encoded = noveltea::core::to_json(parsed);
    noveltea::core::RichTextDocument decoded;
    (void)noveltea::core::rich_text_from_json(encoded, decoded);
#elif NOVELTEA_FUZZ_KIND == 3
    std::vector<noveltea::core::legacy::PackageError> errors;
    (void)noveltea::core::legacy::ProjectPackageReader::read(bytes, errors);
#elif NOVELTEA_FUZZ_KIND == 4
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    const auto parsed = nlohmann::json::parse(text, nullptr, false);
    if (!parsed.is_discarded())
        (void)noveltea::core::decode_runtime_project(parsed);
#else
#error "NOVELTEA_FUZZ_KIND must select a parser"
#endif
}

} // namespace

#if defined(NOVELTEA_USE_LIBFUZZER)
extern "C" int LLVMFuzzerTestOneInput(const std::uint8_t* data, std::size_t size)
{
    exercise_input(std::span<const std::uint8_t>(data, size));
    return 0;
}
#else
int main()
{
    static constexpr std::string_view corpus[] = {
        "",
        "{",
        "[]",
        "null",
        "true",
        "{}",
        "[[]]",
        "\xff\x00\xfe",
        "[b][i]nested[/b][/i]",
        "../../../escape",
        "PK\x03\x04truncated",
    };
    for (const std::string_view input : corpus) {
        exercise_input(std::span<const std::uint8_t>(
            reinterpret_cast<const std::uint8_t*>(input.data()), input.size()));
    }
    return 0;
}
#endif
