#pragma once

#include <nlohmann/json.hpp>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

namespace noveltea::narrative {
using Json = nlohmann::ordered_json;
struct Location {
    int line = 2;
    int column = 1;
};
struct Record {
    std::string path;
    Json metadata;
    std::string body;
    std::string source_revision;
    std::map<std::string, Location> locations;
};
struct Catalog {
    std::vector<Record> records;
    Json diagnostics = Json::array();
    Json references = Json::array();
    Json located(const Record& record, const std::string& pointer,
                 Json value = Json::object()) const;
    void report(const Record& record, const std::string& code, const std::string& message,
                const std::string& pointer = "");
    const Record* find(const std::string& id) const;
};
Catalog read_catalog(const std::filesystem::path& root);
Json analyze(Catalog& catalog);
} // namespace noveltea::narrative
