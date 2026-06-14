#include "noveltea/render/resources.hpp"

#if defined(NOVELTEA_HAS_BGFX)
#include <bgfx/bgfx.h>
#endif

#include <utility>

namespace noveltea {

TextureHandle::~TextureHandle() { reset(); }

TextureHandle::TextureHandle(TextureHandle&& other) noexcept
    : m_index(other.release())
{
}

TextureHandle& TextureHandle::operator=(TextureHandle&& other) noexcept
{
    if (this != &other) {
        reset(other.release());
    }
    return *this;
}

void TextureHandle::reset(uint16_t index)
{
#if defined(NOVELTEA_HAS_BGFX)
    if (valid() && bgfx::isValid(bgfx::TextureHandle{m_index})) {
        bgfx::destroy(bgfx::TextureHandle{m_index});
    }
#endif
    m_index = index;
}

uint16_t TextureHandle::release()
{
    return std::exchange(m_index, invalid_index);
}

ProgramHandle::~ProgramHandle() { reset(); }

ProgramHandle::ProgramHandle(ProgramHandle&& other) noexcept
    : m_index(other.release())
{
}

ProgramHandle& ProgramHandle::operator=(ProgramHandle&& other) noexcept
{
    if (this != &other) {
        reset(other.release());
    }
    return *this;
}

void ProgramHandle::reset(uint16_t index)
{
#if defined(NOVELTEA_HAS_BGFX)
    if (valid() && bgfx::isValid(bgfx::ProgramHandle{m_index})) {
        bgfx::destroy(bgfx::ProgramHandle{m_index});
    }
#endif
    m_index = index;
}

uint16_t ProgramHandle::release()
{
    return std::exchange(m_index, invalid_index);
}

} // namespace noveltea
