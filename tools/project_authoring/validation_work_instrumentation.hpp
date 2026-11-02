#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <string_view>
#include <utility>

namespace noveltea::authoring {

#ifndef NOVELTEA_ENABLE_VALIDATION_COUNTERS
#define NOVELTEA_ENABLE_VALIDATION_COUNTERS 1
#endif

// Observational measurements only: never use these values for cache authority.
enum class WorkCounter : std::size_t {
    DirectoryEnumerations,
    StatReadlinkCalls,
    FileByteReads,
    FileBytesRead,
    ContentHashes,
    ContentBytesHashed,
    SourceCaptures,
    ParsedYaml,
    ParsedLua,
    ParsedRml,
    ParsedRcss,
    RecordContributions,
    DependencyContributions,
    LocalizationChecks,
    FontPreparations,
    MaterialShaderPreparations,
    PortableSourceChecks,
    FullResultAssemblies,
    FontProofReads,
    FontProofHashes,
    FontAssetReads,
    ShaderProofReads,
    ShaderProofHashes,
    GenerationAssetProofReads,
    GenerationAssetProofHashes,
    GenerationTextProofReads,
    SourceGenerationFences,
    DiskSafetyChecks,
    StageLedgerSerializations,
    StageLedgerBytesSerialized,
    ValidationResponseSerializations,
    SessionValidationMicros,
    FontCoverageMicros,
    ShaderValidationMicros,
    SourceGenerationMicros,
    StageLedgerMicros,
    DiskSafetyMicros,
    BrokerAuthorityObservations,
    BrokerAuthorityMicros,
    CompleteProjectPreparationMicros,
    PortableInputPreparationMicros,
    PortableSourceValidationMicros,
    NoticeInputPreparationMicros,
    NoticeValidationMicros,
    StageLedgerConstructionMicros,
    StageLedgerJsonSerializationMicros,
    DeferredPublicationMicros,
    DeferredPublications,
    ValidationResponseSerializationMicros,
    FontBytesRead,
    FontBytesHashed,
    ShaderBytesRead,
    ShaderBytesHashed,
    GenerationAssetBytesRead,
    GenerationAssetBytesHashed,
    CompleteProjectPreparations,
    CompleteProjectPhysicalProjections,
    CompleteProjectSerializationMicros,
    CompleteProjectBytesSerialized,
    Count
};

inline constexpr bool validation_counters_enabled = NOVELTEA_ENABLE_VALIDATION_COUNTERS != 0;
inline constexpr auto work_counter_count = static_cast<std::size_t>(WorkCounter::Count);

class ValidationWorkCounters {
public:
    template<WorkCounter Counter> inline void add(std::size_t amount = 1) noexcept
    {
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        static_assert(Counter < WorkCounter::Count);
        values_[static_cast<std::size_t>(Counter)] += amount;
#else
        (void)amount;
#endif
    }

    template<WorkCounter Counter> std::size_t get() const noexcept
    {
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        return values_[static_cast<std::size_t>(Counter)];
#else
        return 0;
#endif
    }

    // Derived semantic metrics come from the authoritative session,
    // never from ad-hoc writes to observational storage.
    void setSemanticWork(std::size_t records, std::size_t dependencies,
                         std::size_t localization) noexcept
    {
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        values_[static_cast<std::size_t>(WorkCounter::RecordContributions)] = records;
        values_[static_cast<std::size_t>(WorkCounter::DependencyContributions)] = dependencies;
        values_[static_cast<std::size_t>(WorkCounter::LocalizationChecks)] = localization;
#else
        (void)records;
        (void)dependencies;
        (void)localization;
#endif
    }

    auto fields() const noexcept
    {
        constexpr std::array<std::string_view, work_counter_count> names = {
            "directoryEnumerations",
            "statReadlinkCalls",
            "fileByteReads",
            "fileBytesRead",
            "contentHashes",
            "contentBytesHashed",
            "sourceCaptures",
            "parsedYaml",
            "parsedLua",
            "parsedRml",
            "parsedRcss",
            "recordContributions",
            "dependencyContributions",
            "localizationChecks",
            "fontPreparations",
            "materialShaderPreparations",
            "portableSourceChecks",
            "fullResultAssemblies",
            "fontProofReads",
            "fontProofHashes",
            "fontAssetReads",
            "shaderProofReads",
            "shaderProofHashes",
            "generationAssetProofReads",
            "generationAssetProofHashes",
            "generationTextProofReads",
            "sourceGenerationFences",
            "diskSafetyChecks",
            "stageLedgerSerializations",
            "stageLedgerBytesSerialized",
            "validationResponseSerializations",
            "sessionValidationMicros",
            "fontCoverageMicros",
            "shaderValidationMicros",
            "sourceGenerationMicros",
            "stageLedgerMicros",
            "diskSafetyMicros",
            "brokerAuthorityObservations",
            "brokerAuthorityMicros",
            "completeProjectPreparationMicros",
            "portableInputPreparationMicros",
            "portableSourceValidationMicros",
            "noticeInputPreparationMicros",
            "noticeValidationMicros",
            "stageLedgerConstructionMicros",
            "stageLedgerJsonSerializationMicros",
            "deferredPublicationMicros",
            "deferredPublications",
            "validationResponseSerializationMicros",
            "fontBytesRead",
            "fontBytesHashed",
            "shaderBytesRead",
            "shaderBytesHashed",
            "generationAssetBytesRead",
            "generationAssetBytesHashed",
            "completeProjectPreparations",
            "completeProjectPhysicalProjections",
            "completeProjectSerializationMicros",
            "completeProjectBytesSerialized"};
        std::array<std::pair<std::string_view, std::size_t>, work_counter_count> result{};
        for (std::size_t index = 0; index < names.size(); ++index)
            result[index] = {names[index], value(index)};
        return result;
    }

private:
    std::size_t value(std::size_t index) const noexcept
    {
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        return values_[index];
#else
        (void)index;
        return 0;
#endif
    }
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
    std::array<std::size_t, work_counter_count> values_{};
#endif
};

#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
inline thread_local ValidationWorkCounters* active_validation_work = nullptr;
#endif

class ScopedValidationWork {
public:
    explicit ScopedValidationWork(ValidationWorkCounters& work) noexcept
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        : previous_(std::exchange(active_validation_work, &work))
#endif
    {
#if !NOVELTEA_ENABLE_VALIDATION_COUNTERS
        (void)work;
#endif
    }
    ~ScopedValidationWork()
    {
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        active_validation_work = previous_;
#endif
    }
    ScopedValidationWork(const ScopedValidationWork&) = delete;
    ScopedValidationWork& operator=(const ScopedValidationWork&) = delete;

private:
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
    ValidationWorkCounters* previous_;
#endif
};

template<WorkCounter Counter> inline void count_validation_work(std::size_t amount = 1) noexcept
{
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
    if (active_validation_work)
        active_validation_work->add<Counter>(amount);
#else
    (void)amount;
#endif
}

template<WorkCounter Counter> class ScopedValidationStageTime {
public:
    ScopedValidationStageTime() noexcept
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        : start_(std::chrono::steady_clock::now())
#endif
    {
    }
    ~ScopedValidationStageTime()
    {
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
        const auto micros = std::chrono::duration_cast<std::chrono::microseconds>(
            std::chrono::steady_clock::now() - start_);
        count_validation_work<Counter>(static_cast<std::size_t>(micros.count()));
#endif
    }
    ScopedValidationStageTime(const ScopedValidationStageTime&) = delete;
    ScopedValidationStageTime& operator=(const ScopedValidationStageTime&) = delete;

private:
#if NOVELTEA_ENABLE_VALIDATION_COUNTERS
    std::chrono::steady_clock::time_point start_;
#endif
};

} // namespace noveltea::authoring
