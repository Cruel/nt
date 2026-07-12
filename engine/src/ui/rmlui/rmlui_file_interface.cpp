#include "ui/rmlui/rmlui_file_interface.hpp"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <memory>

namespace noveltea::ui::rmlui {
namespace {

bool valid_asset_namespace(std::string_view value)
{
    if (value.empty())
        return false;
    return std::all_of(value.begin(), value.end(), [](char ch) {
        return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
    });
}

struct OpenedRmlFile {
    assets::AssetReaderPtr asset_reader;
    std::string virtual_contents;
    std::size_t virtual_offset = 0;

    explicit OpenedRmlFile(assets::AssetReaderPtr reader) : asset_reader(std::move(reader)) {}
    explicit OpenedRmlFile(std::string contents) : virtual_contents(std::move(contents)) {}

    std::size_t read(void* buffer, std::size_t size)
    {
        if (asset_reader)
            return asset_reader->read(buffer, size);
        const std::size_t remaining =
            virtual_offset < virtual_contents.size() ? virtual_contents.size() - virtual_offset : 0;
        const std::size_t count = std::min(size, remaining);
        if (count > 0) {
            std::memcpy(buffer, virtual_contents.data() + virtual_offset, count);
            virtual_offset += count;
        }
        return count;
    }

    bool seek(long offset, int origin)
    {
        if (asset_reader)
            return asset_reader->seek(offset, origin);
        std::int64_t base = 0;
        if (origin == SEEK_CUR)
            base = static_cast<std::int64_t>(virtual_offset);
        else if (origin == SEEK_END)
            base = static_cast<std::int64_t>(virtual_contents.size());
        const std::int64_t next = base + offset;
        if (next < 0 || static_cast<std::uint64_t>(next) > virtual_contents.size())
            return false;
        virtual_offset = static_cast<std::size_t>(next);
        return true;
    }

    std::size_t tell() const
    {
        if (asset_reader)
            return static_cast<std::size_t>(asset_reader->tell().value_or(0));
        return virtual_offset;
    }
};

} // namespace

std::string resolve_asset_path(const assets::AssetManager& assets, const std::string& path)
{
    const std::size_t encoded_scheme = path.find("|/");
    if (encoded_scheme != std::string::npos && encoded_scheme > 0 &&
        path.find('/') == encoded_scheme + 1) {
        const std::string_view ns(path.data(), encoded_scheme);
        if (valid_asset_namespace(ns) && assets.has_namespace(ns)) {
            return path.substr(0, encoded_scheme) + ":/" + path.substr(encoded_scheme + 2);
        }
    }
    if (path.find(":/") != std::string::npos) {
        return path;
    }
    const std::string rmlui_path = "project:/rmlui/" + path;
    if (assets.exists(rmlui_path)) {
        return rmlui_path;
    }
    return "project:/" + path;
}

AssetRmlFileInterface::AssetRmlFileInterface(const assets::AssetManager& assets) : m_assets(assets)
{
}

void AssetRmlFileInterface::set_virtual_file(std::string path, std::string contents)
{
    m_virtual_files[std::move(path)] = std::move(contents);
}

void AssetRmlFileInterface::clear_virtual_files() { m_virtual_files.clear(); }

Rml::FileHandle AssetRmlFileInterface::Open(const Rml::String& path)
{
    const std::string logical = resolve_asset_path(m_assets, path.c_str());
    if (const auto virtual_file = m_virtual_files.find(logical);
        virtual_file != m_virtual_files.end()) {
        return reinterpret_cast<Rml::FileHandle>(new OpenedRmlFile(virtual_file->second));
    }
    auto opened = m_assets.open(logical);
    if (!opened) {
        std::fprintf(stderr, "[rmlui] failed to open %s as %s: %s\n", path.c_str(), logical.c_str(),
                     opened.error.c_str());
        return 0;
    }
    return reinterpret_cast<Rml::FileHandle>(new OpenedRmlFile(std::move(*opened.value)));
}

void AssetRmlFileInterface::Close(Rml::FileHandle file)
{
    if (file == 0)
        return;
    delete reinterpret_cast<OpenedRmlFile*>(file);
}

size_t AssetRmlFileInterface::Read(void* buffer, size_t size, Rml::FileHandle file)
{
    if (file == 0 || buffer == nullptr || size == 0)
        return 0;
    return reinterpret_cast<OpenedRmlFile*>(file)->read(buffer, size);
}

bool AssetRmlFileInterface::Seek(Rml::FileHandle file, long offset, int origin)
{
    if (file == 0)
        return false;
    return reinterpret_cast<OpenedRmlFile*>(file)->seek(offset, origin);
}

size_t AssetRmlFileInterface::Tell(Rml::FileHandle file)
{
    if (file == 0)
        return 0;
    return reinterpret_cast<OpenedRmlFile*>(file)->tell();
}

} // namespace noveltea::ui::rmlui
