#pragma once

#include <cstdint>

namespace noveltea {

class TextureHandle {
public:
    TextureHandle() = default;
    explicit TextureHandle(uint16_t index) : m_index(index) {}
    ~TextureHandle();

    TextureHandle(const TextureHandle&) = delete;
    TextureHandle& operator=(const TextureHandle&) = delete;
    TextureHandle(TextureHandle&& other) noexcept;
    TextureHandle& operator=(TextureHandle&& other) noexcept;

    [[nodiscard]] bool valid() const { return m_index != invalid_index; }
    [[nodiscard]] uint16_t index() const { return m_index; }
    void reset(uint16_t index = invalid_index);
    uint16_t release();

private:
    static constexpr uint16_t invalid_index = UINT16_MAX;
    uint16_t m_index = invalid_index;
};

class ProgramHandle {
public:
    ProgramHandle() = default;
    explicit ProgramHandle(uint16_t index) : m_index(index) {}
    ~ProgramHandle();

    ProgramHandle(const ProgramHandle&) = delete;
    ProgramHandle& operator=(const ProgramHandle&) = delete;
    ProgramHandle(ProgramHandle&& other) noexcept;
    ProgramHandle& operator=(ProgramHandle&& other) noexcept;

    [[nodiscard]] bool valid() const { return m_index != invalid_index; }
    [[nodiscard]] uint16_t index() const { return m_index; }
    void reset(uint16_t index = invalid_index);
    uint16_t release();

private:
    static constexpr uint16_t invalid_index = UINT16_MAX;
    uint16_t m_index = invalid_index;
};

} // namespace noveltea
