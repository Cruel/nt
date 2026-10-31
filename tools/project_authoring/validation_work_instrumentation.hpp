#pragma once

#include <array>
#include <cstddef>
#include <string_view>
#include <utility>

namespace noveltea::authoring {

// Per-call counters, not cache authority. Only work performed while a caller
// explicitly enables measurement is recorded; nested calls restore their owner.
struct ValidationWorkCounters {
    std::size_t directory_enumerations = 0;
    std::size_t stat_readlink_calls = 0;
    std::size_t file_byte_reads = 0;
    std::size_t content_hashes = 0;
    std::size_t source_captures = 0;
    std::size_t parsed_yaml = 0;
    std::size_t parsed_lua = 0;
    std::size_t parsed_rml = 0;
    std::size_t parsed_rcss = 0;
    std::size_t record_contributions = 0;
    std::size_t dependency_contributions = 0;
    std::size_t localization_checks = 0;
    std::size_t font_preparations = 0;
    std::size_t material_shader_preparations = 0;
    std::size_t portable_source_checks = 0;
    std::size_t full_result_assemblies = 0;

    // Stable field names shared by the nlohmann CLI and jsoncons Node-API
    // serializers. New counters are added here and in the TypeScript schema.
    std::array<std::pair<std::string_view, std::size_t>, 16> fields() const noexcept
    {
        return {{{"directoryEnumerations", directory_enumerations},
                 {"statReadlinkCalls", stat_readlink_calls},
                 {"fileByteReads", file_byte_reads},
                 {"contentHashes", content_hashes},
                 {"sourceCaptures", source_captures},
                 {"parsedYaml", parsed_yaml},
                 {"parsedLua", parsed_lua},
                 {"parsedRml", parsed_rml},
                 {"parsedRcss", parsed_rcss},
                 {"recordContributions", record_contributions},
                 {"dependencyContributions", dependency_contributions},
                 {"localizationChecks", localization_checks},
                 {"fontPreparations", font_preparations},
                 {"materialShaderPreparations", material_shader_preparations},
                 {"portableSourceChecks", portable_source_checks},
                 {"fullResultAssemblies", full_result_assemblies}}};
    }
};

inline thread_local ValidationWorkCounters* active_validation_work = nullptr;

class ScopedValidationWork {
public:
    explicit ScopedValidationWork(ValidationWorkCounters& work) noexcept
        : previous_(std::exchange(active_validation_work, &work))
    {
    }
    ~ScopedValidationWork() { active_validation_work = previous_; }
    ScopedValidationWork(const ScopedValidationWork&) = delete;
    ScopedValidationWork& operator=(const ScopedValidationWork&) = delete;

private:
    ValidationWorkCounters* previous_;
};

inline void count_validation_work(std::size_t ValidationWorkCounters::*counter,
                                  std::size_t amount = 1) noexcept
{
    if (active_validation_work)
        active_validation_work->*counter += amount;
}

} // namespace noveltea::authoring
