#include "noveltea/core/typed_save_slot_store.hpp"

#include <array>
#include <cstdint>
#include <fstream>
#include <limits>
#include <optional>
#include <string_view>
#include <system_error>
#include <type_traits>

namespace noveltea::core {
namespace {

constexpr std::string_view checkpoint_bundle_magic = "NTCHKPT1";
constexpr std::uint32_t checkpoint_bundle_version = 1;
constexpr std::string_view png_signature = "\x89PNG\r\n\x1a\n";

Diagnostics slot_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::string slot_filename(TypedSaveSlotId slot)
{
    return slot.is_autosave() ? "autosave.ntsav"
                              : "slot-" + std::to_string(slot.number()) + ".ntsav";
}

template<class Integer> void append_integer(std::string& output, Integer value)
{
    using Unsigned = std::make_unsigned_t<Integer>;
    const auto encoded = static_cast<Unsigned>(value);
    for (std::size_t index = 0; index < sizeof(Unsigned); ++index)
        output.push_back(static_cast<char>((encoded >> (index * 8u)) & Unsigned{0xff}));
}

void append_string(std::string& output, std::string_view value)
{
    append_integer(output, static_cast<std::uint64_t>(value.size()));
    output.append(value);
}

template<class Integer>
std::optional<Integer> read_integer(std::string_view input, std::size_t& offset)
{
    using Unsigned = std::make_unsigned_t<Integer>;
    if (input.size() - std::min(input.size(), offset) < sizeof(Unsigned))
        return std::nullopt;
    Unsigned decoded = 0;
    for (std::size_t index = 0; index < sizeof(Unsigned); ++index)
        decoded |= static_cast<Unsigned>(static_cast<unsigned char>(input[offset + index]))
                   << (index * 8u);
    offset += sizeof(Unsigned);
    return static_cast<Integer>(decoded);
}

std::optional<std::string> read_string(std::string_view input, std::size_t& offset)
{
    const auto size = read_integer<std::uint64_t>(input, offset);
    if (!size || *size > input.size() - std::min(input.size(), offset) ||
        *size > std::string{}.max_size())
        return std::nullopt;
    std::string value(input.substr(offset, static_cast<std::size_t>(*size)));
    offset += static_cast<std::size_t>(*size);
    return value;
}

Result<std::string, Diagnostics> encode_checkpoint_bundle(const TypedSaveSlotCheckpoint& checkpoint)
{
    if (!checkpoint.metadata)
        return Result<std::string, Diagnostics>::success(checkpoint.encoded_save);
    const auto& metadata = *checkpoint.metadata;
    std::string output;
    output.reserve(checkpoint_bundle_magic.size() + checkpoint.encoded_save.size() +
                   (checkpoint.thumbnail ? checkpoint.thumbnail->bytes.size() : 0u) + 160u);
    output.append(checkpoint_bundle_magic);
    append_integer(output, checkpoint_bundle_version);
    append_string(output, checkpoint.encoded_save);
    append_integer(output, metadata.save_format_version);
    append_string(output, metadata.project.text());
    append_string(output, metadata.project_version);
    append_integer(output, static_cast<std::int64_t>(metadata.play_time.count()));
    append_integer(output, metadata.generations.structural_generation);
    append_integer(output, metadata.generations.captured_structural_generation);
    append_integer(output, metadata.generations.time_generation);
    append_integer(output, metadata.generations.captured_time_generation);
    output.push_back(checkpoint.thumbnail ? '\1' : '\0');
    if (checkpoint.thumbnail) {
        output.push_back(static_cast<char>(checkpoint.thumbnail->encoding));
        append_integer(output, checkpoint.thumbnail->width);
        append_integer(output, checkpoint.thumbnail->height);
        append_string(output, checkpoint.thumbnail->bytes);
    }
    return Result<std::string, Diagnostics>::success(std::move(output));
}

Result<TypedSaveSlotCheckpoint, Diagnostics> decode_checkpoint_bundle(std::string bytes)
{
    if (!std::string_view(bytes).starts_with(checkpoint_bundle_magic))
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::success(
            TypedSaveSlotCheckpoint{std::move(bytes), std::nullopt, std::nullopt});

    const std::string_view input(bytes);
    std::size_t offset = checkpoint_bundle_magic.size();
    const auto version = read_integer<std::uint32_t>(input, offset);
    auto encoded_save = read_string(input, offset);
    const auto format_version = read_integer<std::uint32_t>(input, offset);
    auto project_text = read_string(input, offset);
    auto project_version = read_string(input, offset);
    const auto play_time = read_integer<std::int64_t>(input, offset);
    const auto structural = read_integer<std::uint64_t>(input, offset);
    const auto captured_structural = read_integer<std::uint64_t>(input, offset);
    const auto time = read_integer<std::uint64_t>(input, offset);
    const auto captured_time = read_integer<std::uint64_t>(input, offset);
    if (!version || *version != checkpoint_bundle_version || !encoded_save || !format_version ||
        !project_text || !project_version || !play_time || !structural || !captured_structural ||
        !time || !captured_time || offset >= input.size()) {
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.invalid_checkpoint_bundle",
                       "Save checkpoint bundle is malformed or unsupported."));
    }
    auto project = ProjectId::create(std::move(*project_text));
    auto* project_value = project.value_if();
    if (project_value == nullptr)
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.invalid_checkpoint_project",
                       "Save checkpoint bundle contains an invalid project identity."));

    const bool has_thumbnail = input[offset++] != '\0';
    std::optional<SaveCheckpointThumbnail> thumbnail;
    if (has_thumbnail) {
        if (offset >= input.size())
            return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
                slot_error("save_slot.invalid_checkpoint_bundle",
                           "Save checkpoint thumbnail metadata is truncated."));
        const auto encoding = static_cast<SaveCheckpointThumbnailEncoding>(
            static_cast<unsigned char>(input[offset++]));
        const auto width = read_integer<std::uint32_t>(input, offset);
        const auto height = read_integer<std::uint32_t>(input, offset);
        auto thumbnail_bytes = read_string(input, offset);
        if (encoding != SaveCheckpointThumbnailEncoding::Png || !width || !height || *width == 0 ||
            *height == 0 || !thumbnail_bytes || thumbnail_bytes->size() <= png_signature.size() ||
            !thumbnail_bytes->starts_with(png_signature)) {
            return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
                slot_error("save_slot.invalid_checkpoint_thumbnail",
                           "Save checkpoint thumbnail is malformed or unsupported."));
        }
        thumbnail = SaveCheckpointThumbnail{encoding, *width, *height, std::move(*thumbnail_bytes)};
    }
    if (offset != input.size())
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.invalid_checkpoint_bundle",
                       "Save checkpoint bundle contains trailing data."));

    SaveCheckpointMetadata metadata{
        .save_format_version = *format_version,
        .project = std::move(*project_value),
        .project_version = std::move(*project_version),
        .play_time = std::chrono::milliseconds{*play_time},
        .generations = {*structural, *captured_structural, *time, *captured_time}};
    return Result<TypedSaveSlotCheckpoint, Diagnostics>::success(TypedSaveSlotCheckpoint{
        std::move(*encoded_save), std::move(metadata), std::move(thumbnail)});
}

Result<void, Diagnostics> write_file_atomically(const std::filesystem::path& root,
                                                const std::filesystem::path& destination,
                                                std::string_view bytes)
{
    if (bytes.size() > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max()))
        return Result<void, Diagnostics>::failure(
            slot_error("save_slot.short_write", "Save slot is too large to write safely."));
    std::error_code error;
    std::filesystem::create_directories(root, error);
    if (error)
        return Result<void, Diagnostics>::failure(
            slot_error("save_slot.create_directory_failed",
                       "Could not create save directory: " + error.message()));
    const auto temporary = std::filesystem::path(destination.string() + ".tmp");
    {
        std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
        if (!output)
            return Result<void, Diagnostics>::failure(
                slot_error("save_slot.short_write", "Could not open temporary save slot."));
        output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
        output.flush();
        if (!output) {
            std::filesystem::remove(temporary, error);
            return Result<void, Diagnostics>::failure(
                slot_error("save_slot.short_write", "Save slot could not be written completely."));
        }
    }
    std::filesystem::rename(temporary, destination, error);
    if (error) {
        std::filesystem::remove(temporary, error);
        return Result<void, Diagnostics>::failure(slot_error(
            "save_slot.atomic_replace_failed", "Save slot could not be replaced atomically."));
    }
    return Result<void, Diagnostics>::success();
}

} // namespace

std::size_t TypedSaveSlotIdHash::operator()(const TypedSaveSlotId& slot) const noexcept
{
    const auto kind = static_cast<std::size_t>(slot.kind());
    return (static_cast<std::size_t>(slot.number()) << 1U) ^ kind;
}

Result<TypedSaveSlotCheckpoint, Diagnostics>
TypedSaveSlotStore::read_checkpoint(TypedSaveSlotId slot) const
{
    auto bytes = read_slot(slot);
    auto* value = bytes.value_if();
    if (value == nullptr)
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(std::move(bytes).error());
    return Result<TypedSaveSlotCheckpoint, Diagnostics>::success(
        TypedSaveSlotCheckpoint{std::move(*value), std::nullopt, std::nullopt});
}

Result<void, Diagnostics>
TypedSaveSlotStore::write_checkpoint(TypedSaveSlotId slot,
                                     const TypedSaveSlotCheckpoint& checkpoint)
{
    return write_slot(slot, checkpoint.encoded_save);
}

Result<bool, Diagnostics> TypedMemorySaveSlotStore::has_slot(TypedSaveSlotId slot) const
{
    return Result<bool, Diagnostics>::success(m_slots.contains(slot));
}

Result<std::string, Diagnostics> TypedMemorySaveSlotStore::read_slot(TypedSaveSlotId slot) const
{
    const auto found = m_slots.find(slot);
    if (found == m_slots.end())
        return Result<std::string, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist."));
    return Result<std::string, Diagnostics>::success(found->second.encoded_save);
}

Result<void, Diagnostics> TypedMemorySaveSlotStore::write_slot(TypedSaveSlotId slot,
                                                               std::string_view bytes)
{
    m_slots.insert_or_assign(
        slot, TypedSaveSlotCheckpoint{std::string(bytes), std::nullopt, std::nullopt});
    return Result<void, Diagnostics>::success();
}

Result<TypedSaveSlotCheckpoint, Diagnostics>
TypedMemorySaveSlotStore::read_checkpoint(TypedSaveSlotId slot) const
{
    const auto found = m_slots.find(slot);
    if (found == m_slots.end())
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist."));
    return Result<TypedSaveSlotCheckpoint, Diagnostics>::success(found->second);
}

Result<void, Diagnostics>
TypedMemorySaveSlotStore::write_checkpoint(TypedSaveSlotId slot,
                                           const TypedSaveSlotCheckpoint& checkpoint)
{
    m_slots.insert_or_assign(slot, checkpoint);
    return Result<void, Diagnostics>::success();
}

Result<void, Diagnostics> TypedMemorySaveSlotStore::delete_slot(TypedSaveSlotId slot)
{
    m_slots.erase(slot);
    return Result<void, Diagnostics>::success();
}

std::filesystem::path TypedFilesystemSaveSlotStore::slot_path(TypedSaveSlotId slot) const
{
    return m_root / slot_filename(slot);
}

Result<bool, Diagnostics> TypedFilesystemSaveSlotStore::has_slot(TypedSaveSlotId slot) const
{
    std::error_code error;
    const bool exists = std::filesystem::is_regular_file(slot_path(slot), error);
    if (error)
        return Result<bool, Diagnostics>::failure(
            slot_error("save_slot.stat_failed", "Could not inspect save slot: " + error.message()));
    return Result<bool, Diagnostics>::success(exists);
}

Result<std::string, Diagnostics> TypedFilesystemSaveSlotStore::read_slot(TypedSaveSlotId slot) const
{
    auto checkpoint = read_checkpoint(slot);
    auto* value = checkpoint.value_if();
    if (value == nullptr)
        return Result<std::string, Diagnostics>::failure(std::move(checkpoint).error());
    return Result<std::string, Diagnostics>::success(std::move(value->encoded_save));
}

Result<TypedSaveSlotCheckpoint, Diagnostics>
TypedFilesystemSaveSlotStore::read_checkpoint(TypedSaveSlotId slot) const
{
    const auto path = slot_path(slot);
    std::error_code error;
    if (!std::filesystem::is_regular_file(path, error) || error)
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist or cannot be read."));
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > std::string{}.max_size() ||
        size > static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.short_read", "Save slot size could not be read safely."));
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist or cannot be read."));
    std::string bytes(static_cast<std::size_t>(size), '\0');
    if (!bytes.empty())
        input.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!input || input.gcount() != static_cast<std::streamsize>(bytes.size()))
        return Result<TypedSaveSlotCheckpoint, Diagnostics>::failure(
            slot_error("save_slot.short_read", "Save slot could not be read completely."));
    return decode_checkpoint_bundle(std::move(bytes));
}

Result<void, Diagnostics> TypedFilesystemSaveSlotStore::write_slot(TypedSaveSlotId slot,
                                                                   std::string_view bytes)
{
    return write_file_atomically(m_root, slot_path(slot), bytes);
}

Result<void, Diagnostics>
TypedFilesystemSaveSlotStore::write_checkpoint(TypedSaveSlotId slot,
                                               const TypedSaveSlotCheckpoint& checkpoint)
{
    auto encoded = encode_checkpoint_bundle(checkpoint);
    if (!encoded)
        return Result<void, Diagnostics>::failure(std::move(encoded).error());
    return write_file_atomically(m_root, slot_path(slot), *encoded.value_if());
}

Result<void, Diagnostics> TypedFilesystemSaveSlotStore::delete_slot(TypedSaveSlotId slot)
{
    std::error_code error;
    const bool removed = std::filesystem::remove(slot_path(slot), error);
    if (error)
        return Result<void, Diagnostics>::failure(slot_error(
            "save_slot.delete_failed", "Could not delete save slot: " + error.message()));
    if (!removed)
        return Result<void, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist."));
    return Result<void, Diagnostics>::success();
}

} // namespace noveltea::core
