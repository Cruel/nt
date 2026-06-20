#include "noveltea/render/resources.hpp"

#include <bgfx/bgfx.h>

#include <utility>

namespace noveltea {

TextureHandle::~TextureHandle() { reset(); }

TextureHandle::TextureHandle(TextureHandle&& other) noexcept : m_index(other.release()) {}

TextureHandle& TextureHandle::operator=(TextureHandle&& other) noexcept
{
    if (this != &other) {
        reset(other.release());
    }
    return *this;
}

void TextureHandle::reset(uint16_t index)
{
    if (valid() && bgfx::isValid(bgfx::TextureHandle{m_index})) {
        bgfx::destroy(bgfx::TextureHandle{m_index});
    }
    m_index = index;
}

uint16_t TextureHandle::release() { return std::exchange(m_index, invalid_index); }

ProgramHandle::~ProgramHandle() { reset(); }

ProgramHandle::ProgramHandle(ProgramHandle&& other) noexcept : m_index(other.release()) {}

ProgramHandle& ProgramHandle::operator=(ProgramHandle&& other) noexcept
{
    if (this != &other) {
        reset(other.release());
    }
    return *this;
}

void ProgramHandle::reset(uint16_t index)
{
    if (valid() && bgfx::isValid(bgfx::ProgramHandle{m_index})) {
        bgfx::destroy(bgfx::ProgramHandle{m_index});
    }
    m_index = index;
}

uint16_t ProgramHandle::release() { return std::exchange(m_index, invalid_index); }

} // namespace noveltea
