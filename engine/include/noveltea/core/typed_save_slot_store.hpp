#pragma once

#include "noveltea/core/result.hpp"

#include <compare>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>

namespace noveltea::core {

class TypedSaveSlotId {
public:
    enum class Kind : std::uint8_t {
        Manual,
        Autosave
    };

    [[nodiscard]] static TypedSaveSlotId manual(std::uint32_t number) noexcept
    {
        return TypedSaveSlotId(Kind::Manual, number);
    }
    [[nodiscard]] static TypedSaveSlotId autosave() noexcept
    {
        return TypedSaveSlotId(Kind::Autosave, 0);
    }
    [[nodiscard]] Kind kind() const noexcept { return m_kind; }
    [[nodiscard]] std::uint32_t number() const noexcept { return m_number; }
    [[nodiscard]] bool is_autosave() const noexcept { return m_kind == Kind::Autosave; }
    auto operator<=>(const TypedSaveSlotId&) const = default;

private:
    TypedSaveSlotId(Kind kind, std::uint32_t number) noexcept : m_kind(kind), m_number(number) {}
    Kind m_kind;
    std::uint32_t m_number;
};

struct TypedSaveSlotIdHash {
    [[nodiscard]] std::size_t operator()(const TypedSaveSlotId& slot) const noexcept;
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
};

class TypedMemorySaveSlotStore final : public TypedSaveSlotStore {
public:
    [[nodiscard]] Result<bool, Diagnostics> has_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<std::string, Diagnostics> read_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<void, Diagnostics> write_slot(TypedSaveSlotId slot,
                                                       std::string_view bytes) override;
    [[nodiscard]] Result<void, Diagnostics> delete_slot(TypedSaveSlotId slot) override;

private:
    std::unordered_map<TypedSaveSlotId, std::string, TypedSaveSlotIdHash> m_slots;
};

class TypedFilesystemSaveSlotStore final : public TypedSaveSlotStore {
public:
    explicit TypedFilesystemSaveSlotStore(std::filesystem::path root) : m_root(std::move(root)) {}
    [[nodiscard]] Result<bool, Diagnostics> has_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<std::string, Diagnostics> read_slot(TypedSaveSlotId slot) const override;
    [[nodiscard]] Result<void, Diagnostics> write_slot(TypedSaveSlotId slot,
                                                       std::string_view bytes) override;
    [[nodiscard]] Result<void, Diagnostics> delete_slot(TypedSaveSlotId slot) override;
    [[nodiscard]] const std::filesystem::path& root() const noexcept { return m_root; }

private:
    [[nodiscard]] std::filesystem::path slot_path(TypedSaveSlotId slot) const;
    std::filesystem::path m_root;
};

} // namespace noveltea::core
