#include <catch2/catch_test_macros.hpp>

#include "noveltea/assets/asset_source.hpp"

#include <array>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#define MINIZ_NO_ZLIB_APIS
#if __has_include(<miniz/miniz.h>)
#include <miniz/miniz.h>
#else
#include <miniz.h>
#endif

using namespace noveltea::assets;

namespace {

struct ZipFixtureEntry {
    std::string path;
    AssetBytes bytes;
    mz_uint compression = MZ_DEFAULT_COMPRESSION;
};

AssetBytes bytes(std::string_view value) { return AssetBytes(value.begin(), value.end()); }

AssetBytes make_zip(std::span<const ZipFixtureEntry> entries, bool zip64 = false)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_writer_init_heap_v2(&archive, 0, 0,
                                       zip64 ? static_cast<mz_uint>(MZ_ZIP_FLAG_WRITE_ZIP64) : 0));
    for (const auto& entry : entries) {
        REQUIRE(mz_zip_writer_add_mem(&archive, entry.path.c_str(), entry.bytes.data(),
                                      entry.bytes.size(), entry.compression));
    }

    void* data = nullptr;
    size_t size = 0;
    REQUIRE(mz_zip_writer_finalize_heap_archive(&archive, &data, &size));
    REQUIRE(data != nullptr);
    const auto* first = static_cast<const std::uint8_t*>(data);
    AssetBytes result(first, first + size);
    mz_free(data);
    REQUIRE(mz_zip_writer_end(&archive));
    return result;
}

void write_bytes(const std::filesystem::path& path, std::span<const std::uint8_t> contents)
{
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char*>(contents.data()),
               static_cast<std::streamsize>(contents.size()));
    REQUIRE(file.good());
}

std::uint16_t little_u16(const std::uint8_t* value)
{
    return static_cast<std::uint16_t>(value[0]) |
           static_cast<std::uint16_t>(static_cast<std::uint16_t>(value[1]) << 8u);
}

std::size_t stored_data_offset(const AssetBytes& archive_bytes, std::string_view path)
{
    mz_zip_archive archive{};
    REQUIRE(mz_zip_reader_init_mem(&archive, archive_bytes.data(), archive_bytes.size(), 0));
    const int index = mz_zip_reader_locate_file(&archive, std::string(path).c_str(), nullptr, 0);
    REQUIRE(index >= 0);
    mz_zip_archive_file_stat stat{};
    REQUIRE(mz_zip_reader_file_stat(&archive, static_cast<mz_uint>(index), &stat));
    REQUIRE(stat.m_method == 0);
    REQUIRE(stat.m_local_header_ofs + 30 <= archive_bytes.size());
    const auto offset = static_cast<std::size_t>(stat.m_local_header_ofs);
    const auto data_offset = offset + 30u + little_u16(archive_bytes.data() + offset + 26u) +
                             little_u16(archive_bytes.data() + offset + 28u);
    REQUIRE(mz_zip_reader_end(&archive));
    return data_offset;
}

AssetPath path(std::string_view logical)
{
    const auto parsed = AssetPath::parse(logical);
    REQUIRE(parsed);
    return *parsed;
}

} // namespace

TEST_CASE("ZipAssetSource reports storage metadata and reader seekability")
{
    const std::string compressed_text(4096, 'a');
    const std::array entries = {
        ZipFixtureEntry{"audio/voice.ogg", bytes("0123456789"), MZ_NO_COMPRESSION},
        ZipFixtureEntry{"data/story.txt", bytes(compressed_text), MZ_BEST_COMPRESSION},
    };
    ZipAssetSource source(make_zip(entries));

    const auto stored_path = path("project:/audio/voice.ogg");
    const auto stored = source.stat(stored_path);
    REQUIRE(stored);
    CHECK(stored.value->uncompressed_size == 10);
    REQUIRE(stored.value->compressed_size);
    CHECK(*stored.value->compressed_size == 10);
    CHECK(stored.value->seekable);

    auto stored_reader = source.open(stored_path);
    REQUIRE(stored_reader);
    REQUIRE((*stored_reader.value)->seek(-3, AssetSeekOrigin::End));
    std::array<char, 3> tail{};
    const auto tail_read = (*stored_reader.value)->read(tail.data(), tail.size());
    REQUIRE(tail_read);
    CHECK(*tail_read.value == tail.size());
    CHECK(std::string_view(tail.data(), tail.size()) == "789");

    const auto compressed_path = path("project:/data/story.txt");
    const auto compressed = source.stat(compressed_path);
    REQUIRE(compressed);
    CHECK_FALSE(compressed.value->seekable);
    REQUIRE(compressed.value->compressed_size);
    CHECK(*compressed.value->compressed_size < compressed.value->uncompressed_size);

    auto compressed_reader = source.open(compressed_path);
    REQUIRE(compressed_reader);
    REQUIRE((*compressed_reader.value)->seek(100, AssetSeekOrigin::Begin));
    std::array<char, 4> sample{};
    const auto sample_read = (*compressed_reader.value)->read(sample.data(), sample.size());
    REQUIRE(sample_read);
    CHECK(*sample_read.value == sample.size());
    CHECK(sample == std::array<char, 4>{'a', 'a', 'a', 'a'});
    const auto backward = (*compressed_reader.value)->seek(0, AssetSeekOrigin::Begin);
    CHECK_FALSE(backward);
    CHECK(backward.error.code == asset_source_error_code::seek_failed);
}

TEST_CASE("ZipAssetSource readers have independent cursors and concurrent decompression state")
{
    std::string text;
    for (int index = 0; index < 2048; ++index)
        text += "line-" + std::to_string(index) + "\n";
    const std::array entries = {
        ZipFixtureEntry{"data/shared.txt", bytes(text), MZ_BEST_COMPRESSION},
    };
    ZipAssetSource source(make_zip(entries));
    const auto asset_path = path("project:/data/shared.txt");

    auto first = source.open(asset_path);
    auto second = source.open(asset_path);
    REQUIRE(first);
    REQUIRE(second);
    std::array<char, 7> first_bytes{};
    std::array<char, 7> second_bytes{};
    REQUIRE((*first.value)->read(first_bytes.data(), first_bytes.size()));
    CHECK(*(*second.value)->tell().value == 0);
    REQUIRE((*second.value)->read(second_bytes.data(), second_bytes.size()));
    CHECK(first_bytes == second_bytes);

    std::atomic<bool> valid = true;
    std::vector<std::thread> readers;
    for (int thread_index = 0; thread_index < 8; ++thread_index) {
        readers.emplace_back([&] {
            for (int iteration = 0; iteration < 10; ++iteration) {
                const auto blob = source.read_binary(asset_path);
                if (!blob ||
                    AssetText(blob.value->bytes.begin(), blob.value->bytes.end()) != text) {
                    valid.store(false, std::memory_order_relaxed);
                    return;
                }
            }
        });
    }
    for (auto& reader : readers)
        reader.join();
    CHECK(valid.load(std::memory_order_relaxed));
}

TEST_CASE("ZipAssetSource rejects unsafe archive paths and supports ZIP64")
{
    const std::array unsafe_entries = {
        ZipFixtureEntry{"../escape.txt", bytes("bad"), MZ_NO_COMPRESSION},
    };
    ZipAssetSource unsafe(make_zip(unsafe_entries));
    const auto unsafe_result = unsafe.stat(path("project:/safe.txt"));
    REQUIRE_FALSE(unsafe_result);
    CHECK(unsafe_result.error.code == asset_source_error_code::unsafe_path);

    const std::array zip64_entries = {
        ZipFixtureEntry{"data/zip64.txt", bytes("zip64-ok"), MZ_NO_COMPRESSION},
    };
    const auto zip64_bytes = make_zip(zip64_entries, true);
    mz_zip_archive archive{};
    REQUIRE(mz_zip_reader_init_mem(&archive, zip64_bytes.data(), zip64_bytes.size(), 0));
    CHECK(mz_zip_is_zip64(&archive));
    REQUIRE(mz_zip_reader_end(&archive));

    ZipAssetSource zip64(zip64_bytes);
    const auto blob = zip64.read_binary(path("project:/data/zip64.txt"));
    REQUIRE(blob);
    CHECK(blob.value->bytes == bytes("zip64-ok"));
}

TEST_CASE("ZipAssetSource reports corruption during entry reads")
{
    const std::array entries = {
        ZipFixtureEntry{"data/check.bin", bytes("checksum"), MZ_NO_COMPRESSION},
    };
    auto archive = make_zip(entries);
    const auto data_offset = stored_data_offset(archive, "data/check.bin");
    REQUIRE(data_offset < archive.size());
    archive[data_offset] ^= 0x40u;

    ZipAssetSource source(std::move(archive));
    const auto result = source.read_binary(path("project:/data/check.bin"));
    REQUIRE_FALSE(result);
    CHECK(result.error.code == asset_source_error_code::corrupt);
    CHECK(result.error.message.find("CRC") != std::string::npos);
}

TEST_CASE("ZipAssetSource path backing is reopened per reader and supports source reload")
{
    const auto package_path =
        std::filesystem::temp_directory_path() / "noveltea-zip-source-reload.ntpkg";
    std::filesystem::remove(package_path);

    const std::array first_entries = {
        ZipFixtureEntry{"data/value.txt", bytes("old"), MZ_NO_COMPRESSION},
    };
    write_bytes(package_path, make_zip(first_entries));
    ZipAssetSource first_source(package_path);
    const auto logical_path = path("project:/data/value.txt");
    REQUIRE(first_source.stat(logical_path));
    REQUIRE(first_source.read_binary(logical_path));

    std::filesystem::remove(package_path);
    const auto removed_open = first_source.open(logical_path);
    REQUIRE_FALSE(removed_open);
    CHECK(removed_open.error.code == asset_source_error_code::open_failed);

    const std::array second_entries = {
        ZipFixtureEntry{"data/value.txt", bytes("new"), MZ_NO_COMPRESSION},
    };
    write_bytes(package_path, make_zip(second_entries));
    ZipAssetSource reloaded(package_path);
    const auto new_blob = reloaded.read_binary(logical_path);
    REQUIRE(new_blob);
    CHECK(new_blob.value->bytes == bytes("new"));

    std::filesystem::remove(package_path);
}

TEST_CASE("ZipAssetSource rejects non-seekable long-form audio")
{
    const std::string audio_bytes(4096, 'm');
    const std::array invalid_entries = {
        ZipFixtureEntry{"music/theme.wav", bytes(audio_bytes), MZ_BEST_COMPRESSION},
    };
    ZipAssetSource invalid(make_zip(invalid_entries));
    const auto invalid_result = invalid.stat(path("project:/music/theme.wav"));
    REQUIRE_FALSE(invalid_result);
    CHECK(invalid_result.error.code == asset_source_error_code::unsupported_storage);

    const std::array generic_entries = {
        ZipFixtureEntry{"audio/theme.wav", bytes(audio_bytes), MZ_BEST_COMPRESSION},
        ZipFixtureEntry{"audio/theme.ogg", bytes("stored"), MZ_NO_COMPRESSION},
    };
    ZipAssetSource generic(make_zip(generic_entries));
    const std::array classified = {path("project:/audio/theme.wav")};
    const auto validation = generic.validate_long_form_audio(classified);
    REQUIRE_FALSE(validation);
    CHECK(validation.error.code == asset_source_error_code::unsupported_storage);

    const std::array seekable = {path("project:/audio/theme.ogg")};
    CHECK(generic.validate_long_form_audio(seekable));
}
