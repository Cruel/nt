#pragma once

#include <nlohmann/json.hpp>

#include <cstddef>
#include <filesystem>
#include <map>
#include <string>

namespace noveltea::tooling {

// Resident-only shader preflight evidence. The Project owner must supply its
// independently verified source inventory, never a caller-provided revision.
// No results are serialized to the disk validation cache.
class MaterialShaderValidationCache {
public:
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
    void clear()
    {
        entries_.clear();
        reflection_entries_.clear();
    }

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
};

// One shared projection for both explicit shader commands and resident
// validation; the latter caches individual Material contributions.
nlohmann::json material_reflection_diagnostics(const nlohmann::json& compiled,
                                               const nlohmann::json& effective_materials);

} // namespace noveltea::tooling
