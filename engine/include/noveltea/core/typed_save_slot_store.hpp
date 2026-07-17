#pragma once

#include "noveltea/core/checkpoint_contracts.hpp"
#include "noveltea/core/result.hpp"
#include "noveltea/core/typed_save_slot_id.hpp"

#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace noveltea::core {

struct TypedSaveSlotCheckpoint {
    std::string encoded_save;
    std::optional<SaveCheckpointMetadata> metadata;
    std::optional<SaveCheckpointThumbnail> thumbnail;
    bool operator==(const TypedSaveSlotCheckpoint&) const = default;
};

class TypedSaveSlotStore {
public:
    virtual ~TypedSaveSlotStore() = default;
    [[nodiscard]] virtual Result<bool, Diagnostics> has_slot(TypedSaveSlotId slot) const = 0;
    [[nodiscard]] virtual Result<std::string, Diagnostics>
    read_slot(TypedSaveSlotId slot) const = 0;
    [[nodiscard]] virtual Result<void, Diagnostics> write_slot(TypedSaveSlotId slot,
                                                               std::string_view bytes) = 0;
    [[nodiscard]] virtual Result<void, Diagnostics> delete_slot(TypedSaveSlotId slot) = 0;
    [[nodiscard]] virtual Result<TypedSaveSlotCheckpoint, Diagnostics>
    read_checkpoint(TypedSaveSlotId slot) const;
    [[nodiscard]] virtual Result<void, Diagnostics>
    write_checkpoint(TypedSaveSlotId slot, const TypedSaveSlotCheckpoint& checkpoint);
};

class TypedMemorySaveSlotStore final : public TypedSaveSlotStore {
public:
    [[nodiscard]] Result<bool, Diagnostics> has_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<std::string, Diagnostics> read_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<void, Diagnostics> write_slot(TypedSaveSlotId slot,
                                                       std::string_view bytes) override;
    [[nodiscard]] Result<void, Diagnostics> delete_slot(TypedSaveSlotId slot) override;
    [[nodiscard]] Result<TypedSaveSlotCheckpoint, Diagnostics>
    read_checkpoint(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<void, Diagnostics>
    write_checkpoint(TypedSaveSlotId slot, const TypedSaveSlotCheckpoint& checkpoint) override;

private:
    std::unordered_map<TypedSaveSlotId, TypedSaveSlotCheckpoint, TypedSaveSlotIdHash> m_slots;
};

class TypedFilesystemSaveSlotStore final : public TypedSaveSlotStore {
public:
    explicit TypedFilesystemSaveSlotStore(std::filesystem::path root) : m_root(std::move(root)) {}
    [[nodiscard]] Result<bool, Diagnostics> has_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<std::string, Diagnostics> read_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<void, Diagnostics> write_slot(TypedSaveSlotId slot,
                                                       std::string_view bytes) override;
    [[nodiscard]] Result<void, Diagnostics> delete_slot(TypedSaveSlotId slot) override;
    [[nodiscard]] Result<TypedSaveSlotCheckpoint, Diagnostics>
    read_checkpoint(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<void, Diagnostics>
    write_checkpoint(TypedSaveSlotId slot, const TypedSaveSlotCheckpoint& checkpoint) override;
    [[nodiscard]] const std::filesystem::path& root() const noexcept { return m_root; }

private:
    [[nodiscard]] std::filesystem::path slot_path(TypedSaveSlotId slot) const;
    std::filesystem::path m_root;
};

} // namespace noveltea::core
