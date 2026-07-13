#include "noveltea/core/typed_save_slot_store.hpp"

#include <fstream>
#include <limits>
#include <system_error>

namespace noveltea::core {
namespace {

Diagnostics slot_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::string slot_filename(TypedSaveSlotId slot)
{
    return slot.is_autosave() ? "autosave.ntsav"
                              : "slot-" + std::to_string(slot.number()) + ".ntsav";
}

} // namespace

std::size_t TypedSaveSlotIdHash::operator()(const TypedSaveSlotId& slot) const noexcept
{
    const auto kind = static_cast<std::size_t>(slot.kind());
    return (static_cast<std::size_t>(slot.number()) << 1U) ^ kind;
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
    return Result<std::string, Diagnostics>::success(found->second);
}

Result<void, Diagnostics> TypedMemorySaveSlotStore::write_slot(TypedSaveSlotId slot,
                                                               std::string_view bytes)
{
    m_slots.insert_or_assign(slot, std::string(bytes));
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
    const auto path = slot_path(slot);
    std::error_code error;
    if (!std::filesystem::is_regular_file(path, error) || error)
        return Result<std::string, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist or cannot be read."));
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > std::string{}.max_size() ||
        size > static_cast<std::uintmax_t>(std::numeric_limits<std::streamsize>::max()))
        return Result<std::string, Diagnostics>::failure(
            slot_error("save_slot.short_read", "Save slot size could not be read safely."));
    std::ifstream input(path, std::ios::binary);
    if (!input)
        return Result<std::string, Diagnostics>::failure(
            slot_error("save_slot.missing", "Save slot does not exist or cannot be read."));
    std::string bytes(static_cast<std::size_t>(size), '\0');
    if (!bytes.empty())
        input.read(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!input || input.gcount() != static_cast<std::streamsize>(bytes.size()))
        return Result<std::string, Diagnostics>::failure(
            slot_error("save_slot.short_read", "Save slot could not be read completely."));
    return Result<std::string, Diagnostics>::success(std::move(bytes));
}

Result<void, Diagnostics> TypedFilesystemSaveSlotStore::write_slot(TypedSaveSlotId slot,
                                                                   std::string_view bytes)
{
    if (bytes.size() > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max()))
        return Result<void, Diagnostics>::failure(
            slot_error("save_slot.short_write", "Save slot is too large to write safely."));
    std::error_code error;
    std::filesystem::create_directories(m_root, error);
    if (error)
        return Result<void, Diagnostics>::failure(
            slot_error("save_slot.create_directory_failed",
                       "Could not create save directory: " + error.message()));
    const auto destination = slot_path(slot);
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
