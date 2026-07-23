#pragma once

#include <cassert>
#include <thread>

namespace noveltea::jobs {

class OwnerThreadGuard {
public:
    OwnerThreadGuard() noexcept : m_owner_thread(std::this_thread::get_id()) {}

    [[nodiscard]] bool is_owner_thread() const noexcept
    {
        return std::this_thread::get_id() == m_owner_thread;
    }

    void assert_owner_thread() const noexcept
    {
        assert(is_owner_thread() && "operation must run on the executor owner thread");
    }

private:
    std::thread::id m_owner_thread;
};

} // namespace noveltea::jobs
