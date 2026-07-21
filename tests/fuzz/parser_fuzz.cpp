#include <noveltea/core/rich_text.hpp>
#include <noveltea/core/rich_text_codec.hpp>
#include <noveltea/core/runtime_user_settings_codec.hpp>

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace {

void exercise_input(std::span<const std::uint8_t> bytes)
{
#if NOVELTEA_FUZZ_KIND == 1
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    const auto parsed = noveltea::core::parse_rich_text(text);
    (void)noveltea::core::strip_rich_text_tags(text);
    const auto encoded = noveltea::core::encode_rich_text_document(parsed);
    noveltea::core::RichTextDocument decoded;
    (void)noveltea::core::decode_rich_text_document(encoded, decoded);
#elif NOVELTEA_FUZZ_KIND == 2
    const std::string text(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    const noveltea::core::compiled::AccessibilitySettings accessibility{
        .ui_scale = {.enabled = true, .minimum = 1.0, .maximum = 2.0},
        .text_scale = {.enabled = true, .minimum = 1.0, .maximum = 2.0},
    };
    (void)noveltea::core::decode_runtime_user_settings_text(text, accessibility, "fuzz-input.json");
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
