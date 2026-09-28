#pragma once

#include <cstdint>

namespace noveltea::devtools {

class SequenceAllocator final {
public:
    [[nodiscard]] std::uint64_t next() noexcept { return m_next++; }

private:
    std::uint64_t m_next = 1;
};

} // namespace noveltea::devtools
