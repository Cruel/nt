#pragma once

#include "noveltea/runtime/runtime_ports.hpp"

#include <cstdint>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace noveltea::test_support {

class MemoryScriptSource final : public runtime::ScriptSourcePort {
public:
    void add(std::string logical_path, std::string source)
    {
        m_sources.insert_or_assign(std::move(logical_path), std::move(source));
    }

    void add(std::string logical_path, const std::vector<std::uint8_t>& source)
    {
        add(std::move(logical_path), std::string(source.begin(), source.end()));
    }

    [[nodiscard]] core::Result<std::string, runtime::ScriptSourceError>
    read_script_source(std::string_view logical_path) const override
    {
        const auto found = m_sources.find(std::string(logical_path));
        if (found == m_sources.end()) {
            return core::Result<std::string, runtime::ScriptSourceError>::failure(
                {"Script source not found: " + std::string(logical_path)});
        }
        return core::Result<std::string, runtime::ScriptSourceError>::success(found->second);
    }

private:
    std::unordered_map<std::string, std::string> m_sources;
};

} // namespace noveltea::test_support
