#pragma once

#include "noveltea/jobs/job_executor.hpp"
#include "noveltea/jobs/owner_thread.hpp"

#include <cassert>
#include <cstddef>
#include <deque>
#include <memory>
#include <mutex>
#include <utility>

namespace noveltea::jobs {

// Executor-owned terminal queue. This is intentionally job-specific rather than a
// second generic callback/dispatcher abstraction.
class JobCompletionQueue {
public:
    JobCompletionQueue() = default;

    ~JobCompletionQueue()
    {
        m_owner_thread.assert_owner_thread();
        assert(empty_on_owner() && "executor completion queue must be drained before destruction");
    }

    JobCompletionQueue(const JobCompletionQueue&) = delete;
    JobCompletionQueue& operator=(const JobCompletionQueue&) = delete;

    void enqueue(std::unique_ptr<JobTask> task, JobCompletion completion) noexcept
    {
        assert(task != nullptr);
        assert(completion.contract_valid());
        std::lock_guard lock(m_mutex);
        m_records.push_back(Record{.task = std::move(task), .completion = std::move(completion)});
    }

    [[nodiscard]] std::size_t dispatch_on_owner(std::size_t maximum) noexcept
    {
        m_owner_thread.assert_owner_thread();
        if (maximum == 0 || m_dispatching)
            return 0;

        m_dispatching = true;
        std::size_t dispatched = 0;
        while (dispatched < maximum) {
            std::unique_ptr<JobTask> task;
            JobCompletion completion;
            {
                std::lock_guard lock(m_mutex);
                if (m_records.empty())
                    break;
                task = std::move(m_records.front().task);
                completion = std::move(m_records.front().completion);
                m_records.pop_front();
            }

            task->complete_on_owner(std::move(completion));
            ++dispatched;
        }
        m_dispatching = false;
        return dispatched;
    }

    [[nodiscard]] std::size_t queued_count_on_owner() const noexcept
    {
        m_owner_thread.assert_owner_thread();
        std::lock_guard lock(m_mutex);
        return m_records.size();
    }

    [[nodiscard]] bool empty_on_owner() const noexcept { return queued_count_on_owner() == 0; }

private:
    struct Record {
        std::unique_ptr<JobTask> task;
        JobCompletion completion;
    };

    OwnerThreadGuard m_owner_thread;
    mutable std::mutex m_mutex;
    std::deque<Record> m_records;
    bool m_dispatching = false;
};

} // namespace noveltea::jobs
