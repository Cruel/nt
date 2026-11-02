#pragma once

#include <nlohmann/json.hpp>

#include <cstddef>
#include <filesystem>
#include <map>
#include <memory>
#include <optional>
#include <string>

namespace noveltea::tooling {

// Dependency-keyed shader preflight evidence. The Project owner must supply its
// independently verified source inventory, never a caller-provided revision.
// Restored evidence passes the same exact input/output proofs as resident hits.
class MaterialShaderValidationCache {
public:
    MaterialShaderValidationCache();
    ~MaterialShaderValidationCache();
    MaterialShaderValidationCache(MaterialShaderValidationCache&&) noexcept;
    MaterialShaderValidationCache& operator=(MaterialShaderValidationCache&&) noexcept;
    MaterialShaderValidationCache(const MaterialShaderValidationCache&) = delete;
    MaterialShaderValidationCache& operator=(const MaterialShaderValidationCache&) = delete;

    struct Stage {
        nlohmann::json compiled;
        nlohmann::json reflections;
    };

    struct Work {
        std::size_t compiler_runs = 0;
        std::size_t reused_programs = 0;
        std::size_t output_proofs = 0;
        std::size_t interface_validations = 0;
        std::size_t interface_reuses = 0;
    };

    nlohmann::json validate(const std::filesystem::path& project_root,
                            const nlohmann::json& material_programs,
                            const std::map<std::string, std::string>& source_revisions, Work& work);
    nlohmann::json reflected_materials(const nlohmann::json& compiled,
                                       const nlohmann::json& effective_materials, Work& work);
    // Resident-only fast path. A persisted ledger never imports this evidence.
    std::optional<Stage> reuse_certified_stage(
        const std::filesystem::path& root, const nlohmann::json& material_programs,
        const nlohmann::json& effective_materials,
        const std::map<std::string, std::string>& source_revisions);
    void certify_stage(const std::filesystem::path& root,
                       const nlohmann::json& material_programs,
                       const nlohmann::json& effective_materials,
                       const std::map<std::string, std::string>& source_revisions,
                       const Stage& stage, Work& work);
    nlohmann::json ledger() const;
    bool restore_ledger(const std::filesystem::path& root, const nlohmann::json& snapshot);
    void discard_certified_stage();
    void clear();

private:
    struct Entry {
        nlohmann::json response;
        std::map<std::string, std::string> source_revisions;
        std::map<std::filesystem::path, std::string> engine_revisions;
        bool failed = false;
    };
    struct ReflectionEntry {
        std::string identity;
        nlohmann::json diagnostics;
    };

    std::map<std::string, Entry> entries_;
    std::map<std::string, ReflectionEntry> reflection_entries_;
    struct ArtifactProof;
    struct CertifiedStage {
        nlohmann::json programs;
        nlohmann::json effective;
        std::map<std::string, std::string> dependencies;
        Stage result;
    };
    std::optional<CertifiedStage> certified_stage_;
    std::unique_ptr<ArtifactProof> artifact_proof_;
};

// One shared projection for both explicit shader commands and resident
// validation; the latter caches individual Material contributions.
nlohmann::json material_reflection_diagnostics(const nlohmann::json& compiled,
                                               const nlohmann::json& effective_materials);

} // namespace noveltea::tooling
