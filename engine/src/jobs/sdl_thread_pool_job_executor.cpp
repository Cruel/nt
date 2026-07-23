#include "noveltea/jobs/sdl_thread_pool_job_executor.hpp"

#include "jobs/scheduler_core.hpp"

#include <SDL3/SDL.h>

#include <cassert>
#include <cstdint>
#include <limits>
#include <string>
#include <utility>
#include <vector>

namespace noveltea::jobs {
namespace {

class SdlSchedulerMutex final : public detail::SchedulerMutex {
public:
    SdlSchedulerMutex() : m_mutex(SDL_CreateMutex())
    {
        if (m_mutex == nullptr)
            m_startup_error = SDL_GetError();
    }

    ~SdlSchedulerMutex() override
    {
        if (m_mutex != nullptr)
            SDL_DestroyMutex(m_mutex);
    }

    [[nodiscard]] bool ready() const noexcept { return m_mutex != nullptr; }
    [[nodiscard]] std::string_view startup_error() const noexcept { return m_startup_error; }

    void lock() noexcept override
    {
        if (m_mutex != nullptr)
            SDL_LockMutex(m_mutex);
    }

    void unlock() noexcept override
    {
        if (m_mutex != nullptr)
            SDL_UnlockMutex(m_mutex);
    }

private:
    SDL_Mutex* m_mutex = nullptr;
    std::string m_startup_error;
};

} // namespace

struct SdlThreadPoolJobExecutor::Impl {
    explicit Impl(std::uint32_t requested_worker_count)
        : scheduler(JobExecutionMode::Threaded, default_clock, &scheduler_mutex),
          worker_count(requested_worker_count)
    {
        if (worker_count == 0) {
            startup_error = "SDL job worker count must be greater than zero";
            return;
        }
        if (!scheduler_mutex.ready()) {
            startup_error = scheduler_mutex.startup_error();
            return;
        }

        wake_mutex = SDL_CreateMutex();
        if (wake_mutex == nullptr) {
            startup_error = SDL_GetError();
            return;
        }
        wake_condition = SDL_CreateCondition();
        if (wake_condition == nullptr) {
            startup_error = SDL_GetError();
            SDL_DestroyMutex(wake_mutex);
            wake_mutex = nullptr;
            return;
        }

        workers.reserve(worker_count);
        for (std::uint32_t index = 0; index < worker_count; ++index) {
            const std::string name = "NovelTea Job " + std::to_string(index + 1);
            SDL_Thread* worker = SDL_CreateThread(&Impl::worker_entry, name.c_str(), this);
            if (worker == nullptr) {
                startup_error = SDL_GetError();
                stop_and_join_created_workers();
                return;
            }
            workers.push_back(worker);
        }
        ready = true;
    }

    ~Impl()
    {
        owner_thread.assert_owner_thread();
        if (!scheduler.shutting_down())
            scheduler.begin_shutdown();
        if (!all_workers_joined()) {
            wake_all();
            for (SDL_Thread*& worker : workers) {
                if (worker != nullptr) {
                    SDL_WaitThread(worker, nullptr);
                    worker = nullptr;
                }
            }
            (void)scheduler.dispatch_owner_completions(std::numeric_limits<std::size_t>::max());
        }
        assert(scheduler.shutdown_complete() &&
               "SDL job executor must complete shutdown before destruction");
        if (wake_condition != nullptr)
            SDL_DestroyCondition(wake_condition);
        if (wake_mutex != nullptr)
            SDL_DestroyMutex(wake_mutex);
    }

    static int worker_entry(void* opaque)
    {
        static_cast<Impl*>(opaque)->worker_loop();
        return 0;
    }

    void worker_loop() noexcept
    {
        for (;;) {
            if (scheduler.advance_one_step_from_worker())
                continue;

            SDL_LockMutex(wake_mutex);
            while (!stop_workers && !scheduler.shutting_down() && !scheduler.has_runnable())
                SDL_WaitCondition(wake_condition, wake_mutex);
            const bool should_exit =
                stop_workers || (scheduler.shutting_down() && !scheduler.has_runnable());
            SDL_UnlockMutex(wake_mutex);
            if (should_exit)
                return;
        }
    }

    void wake_one() noexcept
    {
        if (wake_mutex == nullptr || wake_condition == nullptr)
            return;
        SDL_LockMutex(wake_mutex);
        SDL_SignalCondition(wake_condition);
        SDL_UnlockMutex(wake_mutex);
    }

    void wake_all() noexcept
    {
        if (wake_mutex == nullptr || wake_condition == nullptr)
            return;
        SDL_LockMutex(wake_mutex);
        SDL_BroadcastCondition(wake_condition);
        SDL_UnlockMutex(wake_mutex);
    }

    void stop_and_join_created_workers() noexcept
    {
        if (wake_mutex != nullptr && wake_condition != nullptr) {
            SDL_LockMutex(wake_mutex);
            stop_workers = true;
            SDL_BroadcastCondition(wake_condition);
            SDL_UnlockMutex(wake_mutex);
        }
        for (SDL_Thread*& worker : workers) {
            if (worker != nullptr) {
                SDL_WaitThread(worker, nullptr);
                worker = nullptr;
            }
        }
        workers.clear();
        if (wake_condition != nullptr) {
            SDL_DestroyCondition(wake_condition);
            wake_condition = nullptr;
        }
        if (wake_mutex != nullptr) {
            SDL_DestroyMutex(wake_mutex);
            wake_mutex = nullptr;
        }
    }

    void collect_finished_workers() noexcept
    {
        owner_thread.assert_owner_thread();
        for (SDL_Thread*& worker : workers) {
            if (worker != nullptr && SDL_GetThreadState(worker) == SDL_THREAD_COMPLETE) {
                SDL_WaitThread(worker, nullptr);
                worker = nullptr;
            }
        }
    }

    [[nodiscard]] bool all_workers_joined() const noexcept
    {
        for (SDL_Thread* worker : workers) {
            if (worker != nullptr)
                return false;
        }
        return true;
    }

    detail::SteadyJobClock default_clock;
    SdlSchedulerMutex scheduler_mutex;
    detail::SchedulerCore scheduler;
    OwnerThreadGuard owner_thread;
    SDL_Mutex* wake_mutex = nullptr;
    SDL_Condition* wake_condition = nullptr;
    std::vector<SDL_Thread*> workers;
    std::string startup_error;
    std::uint32_t worker_count = 0;
    bool ready = false;
    bool stop_workers = false;
};

SdlThreadPoolJobExecutor::SdlThreadPoolJobExecutor(std::uint32_t worker_count)
    : m_impl(std::make_unique<Impl>(worker_count))
{
}

SdlThreadPoolJobExecutor::~SdlThreadPoolJobExecutor() = default;

bool SdlThreadPoolJobExecutor::ready() const noexcept { return m_impl->ready; }

std::string_view SdlThreadPoolJobExecutor::startup_error() const noexcept
{
    return m_impl->startup_error;
}

std::uint32_t SdlThreadPoolJobExecutor::worker_count() const noexcept
{
    return m_impl->worker_count;
}

JobExecutionMode SdlThreadPoolJobExecutor::mode() const noexcept
{
    return JobExecutionMode::Threaded;
}

core::Result<JobId, core::Diagnostic>
SdlThreadPoolJobExecutor::submit(JobPriority priority, std::unique_ptr<JobTask> task) noexcept
{
    if (!m_impl->ready) {
        return core::Result<JobId, core::Diagnostic>::failure(
            {.code = "jobs.executor_unavailable",
             .message = m_impl->startup_error.empty() ? "SDL job executor is unavailable"
                                                      : m_impl->startup_error});
    }
    auto result = m_impl->scheduler.submit(priority, std::move(task));
    if (result)
        m_impl->wake_one();
    return result;
}

bool SdlThreadPoolJobExecutor::request_cancel(JobId id) noexcept
{
    return m_impl->scheduler.request_cancel(id);
}

bool SdlThreadPoolJobExecutor::set_priority(JobId id, JobPriority priority) noexcept
{
    return m_impl->scheduler.set_priority(id, priority);
}

std::optional<JobProgress> SdlThreadPoolJobExecutor::progress(JobId id) const noexcept
{
    return m_impl->scheduler.progress(id);
}

JobExecutorSnapshot SdlThreadPoolJobExecutor::snapshot_on_owner() const
{
    return m_impl->scheduler.snapshot_on_owner();
}

void SdlThreadPoolJobExecutor::pump(std::chrono::nanoseconds) noexcept
{
    m_impl->owner_thread.assert_owner_thread();
    if (m_impl->scheduler.shutting_down())
        m_impl->collect_finished_workers();
}

std::size_t SdlThreadPoolJobExecutor::dispatch_owner_completions(std::size_t maximum) noexcept
{
    return m_impl->scheduler.dispatch_owner_completions(maximum);
}

void SdlThreadPoolJobExecutor::begin_shutdown() noexcept
{
    m_impl->scheduler.begin_shutdown();
    m_impl->wake_all();
}

bool SdlThreadPoolJobExecutor::shutdown_complete() const noexcept
{
    m_impl->owner_thread.assert_owner_thread();
    return m_impl->all_workers_joined() && m_impl->scheduler.shutdown_complete();
}

} // namespace noveltea::jobs
