#include "tooling_native_c.h"

#include <miniz/miniz.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

constexpr std::size_t kIoBufferSize = 64u * 1024u;
constexpr std::uint64_t kZip32Maximum = 0xffffffffull;

std::filesystem::path filesystem_path_from_utf8(std::string_view value)
{
#if defined(_WIN32)
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        return {};
    std::wstring wide(static_cast<std::size_t>(required), L'\0');
    const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), wide.data(), required);
    if (written != required)
        return {};
    return std::filesystem::path(std::move(wide));
#else
    return std::filesystem::path(value);
#endif
}

struct ArchiveEntry {
    std::filesystem::path source_path;
    std::string source_path_text;
    std::string archive_path;
    std::uint64_t size = 0;
    std::uint32_t mode = 0;
};

enum class ArchiveFormat {
    Zip,
    TarGz
};
enum class ArchiveCompression {
    Store,
    Default,
    Maximum
};

int compression_level(ArchiveCompression compression)
{
    switch (compression) {
    case ArchiveCompression::Store:
        return 0;
    case ArchiveCompression::Maximum:
        return 9;
    case ArchiveCompression::Default:
        return 6;
    }
    return 6;
}

std::optional<std::string> normalize_archive_path(std::string_view value)
{
    std::string normalized(value);
    std::replace(normalized.begin(), normalized.end(), '\\', '/');
    if (normalized.starts_with("./"))
        normalized.erase(0, 2);
    if (normalized.empty() || normalized.front() == '/')
        return std::nullopt;
    if (normalized.size() >= 2 &&
        ((normalized[0] >= 'A' && normalized[0] <= 'Z') ||
         (normalized[0] >= 'a' && normalized[0] <= 'z')) &&
        normalized[1] == ':')
        return std::nullopt;

    std::size_t begin = 0;
    while (begin <= normalized.size()) {
        const std::size_t end = normalized.find('/', begin);
        const std::string_view part(normalized.data() + begin,
                                    (end == std::string::npos ? normalized.size() : end) - begin);
        if (part.empty() || part == "." || part == "..")
            return std::nullopt;
        if (end == std::string::npos)
            break;
        begin = end + 1;
    }
    return normalized;
}

bool parse_request(const nlohmann::json& request, std::filesystem::path& output_path,
                   ArchiveFormat& format, ArchiveCompression& compression,
                   std::vector<ArchiveEntry>& entries, std::string& error)
{
    if (!request.contains("outputPath") || !request["outputPath"].is_string() ||
        !request.contains("format") || !request["format"].is_string() ||
        !request.contains("compression") || !request["compression"].is_string() ||
        !request.contains("entries") || !request["entries"].is_array()) {
        error = "Archive request requires outputPath, format, compression, and entries.";
        return false;
    }

    const std::string output_text = request["outputPath"].get<std::string>();
    output_path = filesystem_path_from_utf8(output_text);
    if (output_text.empty() || output_path.empty()) {
        error = "Archive request has an invalid outputPath.";
        return false;
    }

    const std::string format_text = request["format"].get<std::string>();
    if (format_text == "zip")
        format = ArchiveFormat::Zip;
    else if (format_text == "tar.gz")
        format = ArchiveFormat::TarGz;
    else {
        error = "Archive request format must be 'zip' or 'tar.gz'.";
        return false;
    }

    const std::string compression_text = request["compression"].get<std::string>();
    if (compression_text == "store")
        compression = ArchiveCompression::Store;
    else if (compression_text == "default")
        compression = ArchiveCompression::Default;
    else if (compression_text == "maximum")
        compression = ArchiveCompression::Maximum;
    else {
        error = "Archive request compression must be 'store', 'default', or 'maximum'.";
        return false;
    }

    entries.clear();
    entries.reserve(request["entries"].size());
    for (const auto& item : request["entries"]) {
        if (!item.is_object() || !item.contains("sourcePath") || !item["sourcePath"].is_string() ||
            !item.contains("archivePath") || !item["archivePath"].is_string() ||
            !item.contains("size") || !item["size"].is_number_integer() || !item.contains("mode") ||
            !item["mode"].is_number_integer()) {
            error = "Archive entries require sourcePath, archivePath, size, and mode.";
            return false;
        }
        const auto size_value = item["size"].get<std::int64_t>();
        const auto mode_value = item["mode"].get<std::int64_t>();
        if (size_value < 0 || mode_value < 0 || mode_value > 0777) {
            error = "Archive entry size or mode is invalid.";
            return false;
        }
        const std::string source_text = item["sourcePath"].get<std::string>();
        auto archive_path = normalize_archive_path(item["archivePath"].get<std::string>());
        if (source_text.empty() || !archive_path) {
            error = "Archive entry contains an invalid source or archive path.";
            return false;
        }
        entries.push_back({filesystem_path_from_utf8(source_text), source_text,
                           std::move(*archive_path), static_cast<std::uint64_t>(size_value),
                           static_cast<std::uint32_t>(mode_value)});
    }
    std::sort(entries.begin(), entries.end(), [](const ArchiveEntry& lhs, const ArchiveEntry& rhs) {
        return lhs.archive_path < rhs.archive_path;
    });
    return true;
}

class FileWriter {
public:
    explicit FileWriter(const std::filesystem::path& path)
        : m_output(path, std::ios::binary | std::ios::trunc)
    {
    }

    [[nodiscard]] bool valid() const { return static_cast<bool>(m_output); }
    [[nodiscard]] std::uint64_t offset() const { return m_offset; }

    bool write(const void* data, std::size_t size)
    {
        if (size == 0)
            return true;
        m_output.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
        if (!m_output)
            return false;
        m_offset += size;
        return true;
    }

private:
    std::ofstream m_output;
    std::uint64_t m_offset = 0;
};

void append_u16(std::vector<std::uint8_t>& output, std::uint16_t value)
{
    output.push_back(static_cast<std::uint8_t>(value & 0xffu));
    output.push_back(static_cast<std::uint8_t>((value >> 8u) & 0xffu));
}

void append_u32(std::vector<std::uint8_t>& output, std::uint32_t value)
{
    output.push_back(static_cast<std::uint8_t>(value & 0xffu));
    output.push_back(static_cast<std::uint8_t>((value >> 8u) & 0xffu));
    output.push_back(static_cast<std::uint8_t>((value >> 16u) & 0xffu));
    output.push_back(static_cast<std::uint8_t>((value >> 24u) & 0xffu));
}

std::vector<std::uint8_t> zip_local_header(std::string_view name, std::uint16_t method)
{
    std::vector<std::uint8_t> output;
    output.reserve(30 + name.size());
    append_u32(output, 0x04034b50u);
    append_u16(output, 20u);
    append_u16(output, 0x0808u);
    append_u16(output, method);
    append_u16(output, 0u);
    append_u16(output, 33u);
    append_u32(output, 0u);
    append_u32(output, 0u);
    append_u32(output, 0u);
    append_u16(output, static_cast<std::uint16_t>(name.size()));
    append_u16(output, 0u);
    output.insert(output.end(), name.begin(), name.end());
    return output;
}

std::vector<std::uint8_t> zip_data_descriptor(std::uint32_t crc, std::uint32_t compressed_size,
                                              std::uint32_t size)
{
    std::vector<std::uint8_t> output;
    output.reserve(16);
    append_u32(output, 0x08074b50u);
    append_u32(output, crc);
    append_u32(output, compressed_size);
    append_u32(output, size);
    return output;
}

std::vector<std::uint8_t> zip_central_header(std::string_view name, std::uint16_t method,
                                             std::uint32_t crc, std::uint32_t compressed_size,
                                             std::uint32_t size, std::uint32_t mode,
                                             std::uint32_t offset)
{
    std::vector<std::uint8_t> output;
    output.reserve(46 + name.size());
    append_u32(output, 0x02014b50u);
    append_u16(output, 0x0314u);
    append_u16(output, 20u);
    append_u16(output, 0x0808u);
    append_u16(output, method);
    append_u16(output, 0u);
    append_u16(output, 33u);
    append_u32(output, crc);
    append_u32(output, compressed_size);
    append_u32(output, size);
    append_u16(output, static_cast<std::uint16_t>(name.size()));
    append_u16(output, 0u);
    append_u16(output, 0u);
    append_u16(output, 0u);
    append_u16(output, 0u);
    append_u32(output, (0100000u | (mode & 0777u)) << 16u);
    append_u32(output, offset);
    output.insert(output.end(), name.begin(), name.end());
    return output;
}

bool stream_zip_entry(FileWriter& writer, const ArchiveEntry& entry, std::uint16_t method,
                      ArchiveCompression compression, std::uint32_t& crc_result,
                      std::uint32_t& compressed_size_result, std::uint32_t& size_result,
                      std::string& error)
{
    std::ifstream input(entry.source_path, std::ios::binary);
    if (!input) {
        error = "Cannot read archive input '" + entry.source_path_text + "'.";
        return false;
    }

    const std::uint64_t start_offset = writer.offset();
    std::uint64_t actual_size = 0;
    mz_ulong crc = mz_crc32(0, nullptr, 0);
    std::array<std::uint8_t, kIoBufferSize> input_buffer{};
    std::array<std::uint8_t, kIoBufferSize> output_buffer{};

    mz_stream stream{};
    const bool compressed = method == 8u;
    if (compressed && mz_deflateInit2(&stream, compression_level(compression), MZ_DEFLATED,
                                      -MZ_DEFAULT_WINDOW_BITS, 8, MZ_DEFAULT_STRATEGY) != MZ_OK) {
        error = "Cannot initialize ZIP deflate stream.";
        return false;
    }

    bool ok = true;
    while (ok && input) {
        input.read(reinterpret_cast<char*>(input_buffer.data()),
                   static_cast<std::streamsize>(input_buffer.size()));
        const auto count = input.gcount();
        if (count <= 0)
            break;
        const auto chunk_size = static_cast<std::size_t>(count);
        actual_size += chunk_size;
        if (actual_size > kZip32Maximum) {
            error = "ZIP64 output is not supported by the platform exporter.";
            ok = false;
            break;
        }
        crc = mz_crc32(crc, input_buffer.data(), chunk_size);
        if (!compressed) {
            if (!writer.write(input_buffer.data(), chunk_size)) {
                error = "Cannot write ZIP archive output.";
                ok = false;
            }
            continue;
        }

        stream.next_in = input_buffer.data();
        stream.avail_in = static_cast<mz_uint>(chunk_size);
        while (ok && stream.avail_in > 0) {
            stream.next_out = output_buffer.data();
            stream.avail_out = static_cast<mz_uint>(output_buffer.size());
            if (mz_deflate(&stream, MZ_NO_FLUSH) != MZ_OK) {
                error = "ZIP deflate failed.";
                ok = false;
                break;
            }
            const std::size_t produced = output_buffer.size() - stream.avail_out;
            if (!writer.write(output_buffer.data(), produced)) {
                error = "Cannot write ZIP archive output.";
                ok = false;
            }
        }
    }
    if (input.bad()) {
        error = "Cannot read archive input '" + entry.source_path_text + "'.";
        ok = false;
    }

    if (ok && compressed) {
        int result = MZ_OK;
        while (result != MZ_STREAM_END) {
            stream.next_out = output_buffer.data();
            stream.avail_out = static_cast<mz_uint>(output_buffer.size());
            result = mz_deflate(&stream, MZ_FINISH);
            if (result != MZ_OK && result != MZ_STREAM_END) {
                error = "ZIP deflate finalization failed.";
                ok = false;
                break;
            }
            const std::size_t produced = output_buffer.size() - stream.avail_out;
            if (!writer.write(output_buffer.data(), produced)) {
                error = "Cannot write ZIP archive output.";
                ok = false;
                break;
            }
        }
    }
    if (compressed)
        mz_deflateEnd(&stream);
    if (!ok)
        return false;
    if (actual_size != entry.size) {
        error = "Archive input '" + entry.source_path_text + "' changed while packaging.";
        return false;
    }

    const std::uint64_t compressed_size = writer.offset() - start_offset;
    if (compressed_size > kZip32Maximum) {
        error = "ZIP64 output is not supported by the platform exporter.";
        return false;
    }
    crc_result = static_cast<std::uint32_t>(crc);
    compressed_size_result = static_cast<std::uint32_t>(compressed_size);
    size_result = static_cast<std::uint32_t>(actual_size);
    return true;
}

bool create_zip(const std::filesystem::path& output_path, const std::vector<ArchiveEntry>& entries,
                ArchiveCompression compression, std::string& error)
{
    if (entries.size() > 0xffffu) {
        error = "ZIP archive contains too many entries.";
        return false;
    }
    FileWriter writer(output_path);
    if (!writer.valid()) {
        error = "Cannot open ZIP archive output.";
        return false;
    }

    std::vector<std::vector<std::uint8_t>> central_headers;
    central_headers.reserve(entries.size());
    for (const auto& entry : entries) {
        if (entry.size > kZip32Maximum) {
            error = "ZIP64 output is not supported by the platform exporter.";
            return false;
        }
        if (entry.archive_path.size() > 0xffffu) {
            error = "ZIP archive path is too long.";
            return false;
        }
        if (writer.offset() > kZip32Maximum) {
            error = "ZIP64 output is not supported by the platform exporter.";
            return false;
        }

        const std::uint16_t method = compression == ArchiveCompression::Store ? 0u : 8u;
        const std::uint32_t entry_offset = static_cast<std::uint32_t>(writer.offset());
        const auto local = zip_local_header(entry.archive_path, method);
        if (!writer.write(local.data(), local.size())) {
            error = "Cannot write ZIP local header.";
            return false;
        }

        std::uint32_t crc = 0;
        std::uint32_t compressed_size = 0;
        std::uint32_t size = 0;
        if (!stream_zip_entry(writer, entry, method, compression, crc, compressed_size, size,
                              error))
            return false;
        const auto descriptor = zip_data_descriptor(crc, compressed_size, size);
        if (writer.offset() + descriptor.size() > kZip32Maximum ||
            !writer.write(descriptor.data(), descriptor.size())) {
            error = "ZIP64 output is not supported by the platform exporter.";
            return false;
        }
        central_headers.push_back(zip_central_header(
            entry.archive_path, method, crc, compressed_size, size, entry.mode, entry_offset));
    }

    const std::uint64_t central_offset = writer.offset();
    for (const auto& header : central_headers) {
        if (!writer.write(header.data(), header.size())) {
            error = "Cannot write ZIP central directory.";
            return false;
        }
    }
    const std::uint64_t central_size = writer.offset() - central_offset;
    if (central_offset > kZip32Maximum || central_size > kZip32Maximum) {
        error = "ZIP64 output is not supported by the platform exporter.";
        return false;
    }

    std::vector<std::uint8_t> end;
    end.reserve(22);
    append_u32(end, 0x06054b50u);
    append_u16(end, 0u);
    append_u16(end, 0u);
    append_u16(end, static_cast<std::uint16_t>(entries.size()));
    append_u16(end, static_cast<std::uint16_t>(entries.size()));
    append_u32(end, static_cast<std::uint32_t>(central_size));
    append_u32(end, static_cast<std::uint32_t>(central_offset));
    append_u16(end, 0u);
    if (!writer.write(end.data(), end.size())) {
        error = "Cannot finalize ZIP archive.";
        return false;
    }
    return true;
}

class GzipWriter {
public:
    GzipWriter(const std::filesystem::path& output_path, int level, std::string& error)
        : m_output(output_path, std::ios::binary | std::ios::trunc)
    {
        if (!m_output) {
            error = "Cannot open tar.gz archive output.";
            return;
        }
        if (mz_deflateInit2(&m_stream, level, MZ_DEFLATED, -MZ_DEFAULT_WINDOW_BITS, 8,
                            MZ_DEFAULT_STRATEGY) != MZ_OK) {
            error = "Cannot initialize gzip deflate stream.";
            return;
        }
        m_initialized = true;
        constexpr std::array<std::uint8_t, 10> header{0x1f, 0x8b, 0x08, 0x00, 0x00,
                                                      0x00, 0x00, 0x00, 0x00, 0xff};
        if (!write_output(header.data(), header.size(), error)) {
            mz_deflateEnd(&m_stream);
            m_initialized = false;
            return;
        }
        m_crc = mz_crc32(0, nullptr, 0);
    }

    ~GzipWriter()
    {
        if (m_initialized)
            mz_deflateEnd(&m_stream);
    }

    [[nodiscard]] bool valid() const { return m_initialized; }

    bool write(const void* data, std::size_t size, std::string& error)
    {
        const auto* cursor = static_cast<const std::uint8_t*>(data);
        while (size > 0) {
            const auto chunk = static_cast<mz_uint>(
                std::min<std::size_t>(size, std::numeric_limits<mz_uint>::max()));
            m_crc = mz_crc32(m_crc, cursor, chunk);
            m_uncompressed_size += chunk;
            m_stream.next_in = cursor;
            m_stream.avail_in = chunk;
            while (m_stream.avail_in > 0) {
                m_stream.next_out = m_buffer.data();
                m_stream.avail_out = static_cast<mz_uint>(m_buffer.size());
                if (mz_deflate(&m_stream, MZ_NO_FLUSH) != MZ_OK) {
                    error = "gzip compression failed.";
                    return false;
                }
                if (!flush_buffer(error))
                    return false;
            }
            cursor += chunk;
            size -= chunk;
        }
        return true;
    }

    bool finish(std::string& error)
    {
        int result = MZ_OK;
        while (result != MZ_STREAM_END) {
            m_stream.next_out = m_buffer.data();
            m_stream.avail_out = static_cast<mz_uint>(m_buffer.size());
            result = mz_deflate(&m_stream, MZ_FINISH);
            if (result != MZ_OK && result != MZ_STREAM_END) {
                error = "gzip finalization failed.";
                return false;
            }
            if (!flush_buffer(error))
                return false;
        }
        mz_deflateEnd(&m_stream);
        m_initialized = false;

        std::array<std::uint8_t, 8> trailer{};
        const auto crc = static_cast<std::uint32_t>(m_crc);
        trailer[0] = static_cast<std::uint8_t>(crc & 0xffu);
        trailer[1] = static_cast<std::uint8_t>((crc >> 8u) & 0xffu);
        trailer[2] = static_cast<std::uint8_t>((crc >> 16u) & 0xffu);
        trailer[3] = static_cast<std::uint8_t>((crc >> 24u) & 0xffu);
        trailer[4] = static_cast<std::uint8_t>(m_uncompressed_size & 0xffu);
        trailer[5] = static_cast<std::uint8_t>((m_uncompressed_size >> 8u) & 0xffu);
        trailer[6] = static_cast<std::uint8_t>((m_uncompressed_size >> 16u) & 0xffu);
        trailer[7] = static_cast<std::uint8_t>((m_uncompressed_size >> 24u) & 0xffu);
        return write_output(trailer.data(), trailer.size(), error);
    }

private:
    bool write_output(const void* data, std::size_t size, std::string& error)
    {
        if (size == 0)
            return true;
        m_output.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
        if (!m_output) {
            error = "Cannot write tar.gz archive output.";
            return false;
        }
        return true;
    }

    bool flush_buffer(std::string& error)
    {
        const std::size_t produced = m_buffer.size() - m_stream.avail_out;
        return write_output(m_buffer.data(), produced, error);
    }

    std::ofstream m_output;
    mz_stream m_stream{};
    std::array<std::uint8_t, kIoBufferSize> m_buffer{};
    mz_ulong m_crc = 0;
    std::uint32_t m_uncompressed_size = 0;
    bool m_initialized = false;
};

bool write_tar_octal(std::array<std::uint8_t, 512>& output, std::size_t offset, std::size_t length,
                     std::uint64_t value)
{
    std::string octal;
    if (value == 0)
        octal = "0";
    else {
        while (value > 0) {
            octal.push_back(static_cast<char>('0' + (value & 7u)));
            value >>= 3u;
        }
        std::reverse(octal.begin(), octal.end());
    }
    if (octal.size() > length - 1)
        return false;
    const std::size_t padding = length - 1 - octal.size();
    std::fill_n(output.begin() + static_cast<std::ptrdiff_t>(offset), padding,
                static_cast<std::uint8_t>('0'));
    std::memcpy(output.data() + offset + padding, octal.data(), octal.size());
    output[offset + length - 1] = 0;
    return true;
}

struct UstarPath {
    std::string_view name;
    std::string_view prefix;
};

std::optional<UstarPath> split_ustar_path(std::string_view value)
{
    if (value.size() <= 100u)
        return UstarPath{value, {}};
    std::size_t slash = value.rfind('/');
    while (slash != std::string_view::npos && slash > 0) {
        const auto prefix = value.substr(0, slash);
        const auto name = value.substr(slash + 1);
        if (name.size() <= 100u && prefix.size() <= 155u)
            return UstarPath{name, prefix};
        slash = value.rfind('/', slash - 1);
    }
    return std::nullopt;
}

std::optional<std::array<std::uint8_t, 512>>
tar_header(std::string_view archive_path, std::uint64_t size, std::uint32_t mode, char type)
{
    const auto split = split_ustar_path(archive_path);
    if (!split)
        return std::nullopt;
    std::array<std::uint8_t, 512> output{};
    std::memcpy(output.data(), split->name.data(), split->name.size());
    if (!write_tar_octal(output, 100, 8, mode & 0777u) || !write_tar_octal(output, 108, 8, 0) ||
        !write_tar_octal(output, 116, 8, 0) || !write_tar_octal(output, 124, 12, size) ||
        !write_tar_octal(output, 136, 12, 0))
        return std::nullopt;
    std::fill(output.begin() + 148, output.begin() + 156, static_cast<std::uint8_t>(' '));
    output[156] = static_cast<std::uint8_t>(type);
    const char magic[] = {'u', 's', 't', 'a', 'r', '\0'};
    std::memcpy(output.data() + 257, magic, sizeof(magic));
    output[263] = '0';
    output[264] = '0';
    if (!split->prefix.empty())
        std::memcpy(output.data() + 345, split->prefix.data(), split->prefix.size());
    std::uint64_t checksum = 0;
    for (const auto byte : output)
        checksum += byte;
    std::string checksum_octal;
    if (checksum == 0)
        checksum_octal = "0";
    else {
        while (checksum > 0) {
            checksum_octal.push_back(static_cast<char>('0' + (checksum & 7u)));
            checksum >>= 3u;
        }
        std::reverse(checksum_octal.begin(), checksum_octal.end());
    }
    if (checksum_octal.size() > 6u)
        return std::nullopt;
    std::fill(output.begin() + 148, output.begin() + 154, static_cast<std::uint8_t>('0'));
    std::memcpy(output.data() + 154 - checksum_octal.size(), checksum_octal.data(),
                checksum_octal.size());
    output[154] = 0;
    output[155] = ' ';
    return output;
}

std::vector<std::uint8_t> pax_record(std::string_view key, std::string_view value)
{
    const std::string body = std::string(key) + "=" + std::string(value) + "\n";
    std::size_t length = body.size() + 3u;
    while (true) {
        const std::string text = std::to_string(length) + " " + body;
        if (text.size() == length)
            return std::vector<std::uint8_t>(text.begin(), text.end());
        length = text.size();
    }
}

std::size_t tar_padding(std::uint64_t size)
{
    return static_cast<std::size_t>((512u - (size % 512u)) % 512u);
}

std::string posix_basename(std::string_view path)
{
    const auto slash = path.rfind('/');
    return std::string(slash == std::string_view::npos ? path : path.substr(slash + 1));
}

bool write_zeroes(GzipWriter& writer, std::size_t count, std::string& error)
{
    std::array<std::uint8_t, 1024> zeroes{};
    while (count > 0) {
        const std::size_t chunk = std::min(count, zeroes.size());
        if (!writer.write(zeroes.data(), chunk, error))
            return false;
        count -= chunk;
    }
    return true;
}

bool create_tar_gz(const std::filesystem::path& output_path,
                   const std::vector<ArchiveEntry>& entries, ArchiveCompression compression,
                   std::string& error)
{
    GzipWriter writer(output_path, compression_level(compression), error);
    if (!writer.valid())
        return false;

    std::size_t pax_index = 0;
    std::array<std::uint8_t, kIoBufferSize> buffer{};
    for (const auto& entry : entries) {
        std::string header_path = entry.archive_path;
        if (!split_ustar_path(entry.archive_path)) {
            const auto pax = pax_record("path", entry.archive_path);
            std::string pax_path = "PaxHeaders.NovelTea/";
            std::string index_text = std::to_string(pax_index++);
            pax_path.append(8u - std::min<std::size_t>(8u, index_text.size()), '0');
            pax_path += index_text;
            const auto pax_header = tar_header(pax_path, pax.size(), 0644u, 'x');
            if (!pax_header || !writer.write(pax_header->data(), pax_header->size(), error) ||
                !writer.write(pax.data(), pax.size(), error) ||
                !write_zeroes(writer, tar_padding(pax.size()), error)) {
                if (error.empty())
                    error = "Cannot write tar PAX header.";
                return false;
            }
            header_path = posix_basename(entry.archive_path);
            if (header_path.empty())
                header_path = "entry-" + std::to_string(pax_index);
            if (header_path.size() > 100u)
                header_path.resize(100u);
        }

        const auto header = tar_header(header_path, entry.size, entry.mode, '0');
        if (!header) {
            error = "Tar entry header cannot represent archive path or size.";
            return false;
        }
        if (!writer.write(header->data(), header->size(), error))
            return false;

        std::ifstream input(entry.source_path, std::ios::binary);
        if (!input) {
            error = "Cannot read archive input '" + entry.source_path_text + "'.";
            return false;
        }
        std::uint64_t actual_size = 0;
        while (input) {
            input.read(reinterpret_cast<char*>(buffer.data()),
                       static_cast<std::streamsize>(buffer.size()));
            const auto count = input.gcount();
            if (count <= 0)
                break;
            actual_size += static_cast<std::uint64_t>(count);
            if (!writer.write(buffer.data(), static_cast<std::size_t>(count), error))
                return false;
        }
        if (input.bad()) {
            error = "Cannot read archive input '" + entry.source_path_text + "'.";
            return false;
        }
        if (actual_size != entry.size) {
            error = "Archive input '" + entry.source_path_text + "' changed while packaging.";
            return false;
        }
        if (!write_zeroes(writer, tar_padding(actual_size), error))
            return false;
    }
    if (!write_zeroes(writer, 1024u, error))
        return false;
    return writer.finish(error);
}

std::uint64_t write_response(const nlohmann::json& result, std::uint8_t* response,
                             std::uint64_t response_capacity)
{
    const std::string text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required)
        std::memcpy(response, text.data(), static_cast<std::size_t>(required));
    return required;
}

} // namespace

extern "C" std::uint64_t noveltea_tooling_create_archive_json(const std::uint8_t* request,
                                                              std::uint64_t request_size,
                                                              std::uint8_t* response,
                                                              std::uint64_t response_capacity)
{
    const auto input = request == nullptr
                           ? std::string_view{}
                           : std::string_view(reinterpret_cast<const char*>(request),
                                              static_cast<std::size_t>(request_size));
    const auto parsed = nlohmann::json::parse(input, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object())
        return write_response({{"ok", false}, {"error", "Malformed archive request JSON."}},
                              response, response_capacity);

    std::filesystem::path output_path;
    ArchiveFormat format = ArchiveFormat::Zip;
    ArchiveCompression compression = ArchiveCompression::Default;
    std::vector<ArchiveEntry> entries;
    std::string error;
    if (!parse_request(parsed, output_path, format, compression, entries, error))
        return write_response({{"ok", false}, {"error", std::move(error)}}, response,
                              response_capacity);

    const bool ok = format == ArchiveFormat::Zip
                        ? create_zip(output_path, entries, compression, error)
                        : create_tar_gz(output_path, entries, compression, error);
    if (!ok)
        return write_response({{"ok", false}, {"error", std::move(error)}}, response,
                              response_capacity);
    return write_response({{"ok", true}}, response, response_capacity);
}
