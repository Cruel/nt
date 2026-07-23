#pragma once

#include "noveltea/core/diagnostic.hpp"

#include <cassert>
#include <compare>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <type_traits>
#include <utility>

namespace noveltea::assets {

struct AssetRequestId {
    std::uint64_t value = 0;

    [[nodiscard]] bool valid() const noexcept { return value != 0; }
    auto operator<=>(const AssetRequestId&) const = default;
};

struct AssetSourceGeneration {
    std::uint64_t value = 0;

    [[nodiscard]] bool valid() const noexcept { return value != 0; }
    auto operator<=>(const AssetSourceGeneration&) const = default;
};

struct PrefetchGenerationId {
    std::uint64_t value = 0;

    [[nodiscard]] bool valid() const noexcept { return value != 0; }
    auto operator<=>(const PrefetchGenerationId&) const = default;
};

struct AssetCacheKey {
    std::string stable_identity;
    AssetSourceGeneration source_generation;

    [[nodiscard]] bool valid() const noexcept
    {
        return !stable_identity.empty() && source_generation.valid();
    }

    auto operator<=>(const AssetCacheKey&) const = default;
};

enum class AssetRequestReason : std::uint8_t {
    Startup,
    Demand,
    Prefetch,
};

enum class AssetRequestState : std::uint8_t {
    Pending,
    Ready,
    Failed,
    Canceled,
};

enum class AssetCacheState : std::uint8_t {
    Missing,
    Queued,
    Reading,
    Preparing,
    WaitingForOwnerFinalization,
    Resident,
    Failed,
    Canceled,
};

template<class T> class AssetLeaseControl {
public:
    virtual ~AssetLeaseControl() = default;

    virtual void assert_owner_thread() const noexcept = 0;
    virtual void retain_pin_on_owner() noexcept = 0;
    virtual void release_pin_on_owner() noexcept = 0;
    virtual void mark_used_on_owner() noexcept = 0;
    [[nodiscard]] virtual const T& asset_on_owner() const noexcept = 0;
    [[nodiscard]] virtual const AssetCacheKey& cache_key_on_owner() const noexcept = 0;
};

template<class T> class AssetLease {
public:
    AssetLease() = default;

    ~AssetLease() { reset(); }

    AssetLease(const AssetLease& other) : m_control(other.m_control)
    {
        if (m_control != nullptr) {
            m_control->assert_owner_thread();
            m_control->retain_pin_on_owner();
        }
    }

    AssetLease& operator=(const AssetLease& other)
    {
        if (this == &other)
            return *this;
        reset();
        m_control = other.m_control;
        if (m_control != nullptr) {
            m_control->assert_owner_thread();
            m_control->retain_pin_on_owner();
        }
        return *this;
    }

    AssetLease(AssetLease&& other) noexcept = default;

    AssetLease& operator=(AssetLease&& other) noexcept
    {
        if (this == &other)
            return *this;
        reset();
        m_control = std::move(other.m_control);
        return *this;
    }

    [[nodiscard]] static AssetLease
    adopt_existing_pin_on_owner(std::shared_ptr<AssetLeaseControl<T>> control) noexcept
    {
        assert(control != nullptr);
        control->assert_owner_thread();
        return AssetLease(std::move(control));
    }

    [[nodiscard]] explicit operator bool() const noexcept { return m_control != nullptr; }

    [[nodiscard]] const T& asset() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->asset_on_owner();
    }

    [[nodiscard]] const T* operator->() const noexcept { return &asset(); }
    [[nodiscard]] const T& operator*() const noexcept { return asset(); }

    [[nodiscard]] const AssetCacheKey& cache_key() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->cache_key_on_owner();
    }

    void mark_used_on_owner() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        m_control->mark_used_on_owner();
    }

    void reset() noexcept
    {
        if (m_control == nullptr)
            return;
        m_control->assert_owner_thread();
        m_control->release_pin_on_owner();
        m_control.reset();
    }

private:
    explicit AssetLease(std::shared_ptr<AssetLeaseControl<T>> control) noexcept
        : m_control(std::move(control))
    {
    }

    std::shared_ptr<AssetLeaseControl<T>> m_control;
};

template<class T> class AssetRequestControl {
public:
    virtual ~AssetRequestControl() = default;

    virtual void assert_owner_thread() const noexcept = 0;
    [[nodiscard]] virtual AssetRequestId id_on_owner() const noexcept = 0;
    [[nodiscard]] virtual AssetRequestState state_on_owner() const noexcept = 0;
    [[nodiscard]] virtual core::Diagnostics diagnostics_on_owner() const = 0;
    virtual void cancel_on_owner() noexcept = 0;
    [[nodiscard]] virtual std::shared_ptr<AssetLeaseControl<T>>
    take_ready_lease_on_owner() noexcept = 0;
};

template<class T> class AssetRequestHandle {
public:
    AssetRequestHandle() = default;
    ~AssetRequestHandle() { reset(); }

    AssetRequestHandle(const AssetRequestHandle&) = delete;
    AssetRequestHandle& operator=(const AssetRequestHandle&) = delete;

    AssetRequestHandle(AssetRequestHandle&& other) noexcept = default;

    AssetRequestHandle& operator=(AssetRequestHandle&& other) noexcept
    {
        if (this == &other)
            return *this;
        reset();
        m_control = std::move(other.m_control);
        return *this;
    }

    [[nodiscard]] static AssetRequestHandle
    from_control_on_owner(std::unique_ptr<AssetRequestControl<T>> control) noexcept
    {
        assert(control != nullptr);
        control->assert_owner_thread();
        assert(control->id_on_owner().valid());
        return AssetRequestHandle(std::move(control));
    }

    [[nodiscard]] explicit operator bool() const noexcept { return m_control != nullptr; }

    [[nodiscard]] AssetRequestId id() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->id_on_owner();
    }

    [[nodiscard]] AssetRequestState state() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->state_on_owner();
    }

    [[nodiscard]] core::Diagnostics diagnostics() const
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->diagnostics_on_owner();
    }

    void cancel() noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        m_control->cancel_on_owner();
    }

    [[nodiscard]] std::optional<AssetLease<T>> take_ready() && noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        if (m_control->state_on_owner() != AssetRequestState::Ready)
            return std::nullopt;

        auto lease_control = m_control->take_ready_lease_on_owner();
        if (lease_control == nullptr)
            return std::nullopt;
        m_control.reset();
        return AssetLease<T>::adopt_existing_pin_on_owner(std::move(lease_control));
    }

    void reset() noexcept
    {
        if (m_control == nullptr)
            return;
        m_control->assert_owner_thread();
        m_control->cancel_on_owner();
        m_control.reset();
    }

private:
    explicit AssetRequestHandle(std::unique_ptr<AssetRequestControl<T>> control) noexcept
        : m_control(std::move(control))
    {
    }

    std::unique_ptr<AssetRequestControl<T>> m_control;
};

class PrefetchTicketControl {
public:
    virtual ~PrefetchTicketControl() = default;

    virtual void assert_owner_thread() const noexcept = 0;
    [[nodiscard]] virtual AssetRequestId request_id_on_owner() const noexcept = 0;
    [[nodiscard]] virtual PrefetchGenerationId generation_on_owner() const noexcept = 0;
    virtual void cancel_on_owner() noexcept = 0;
};

class PrefetchTicket {
public:
    PrefetchTicket() = default;
    ~PrefetchTicket() { reset(); }

    PrefetchTicket(const PrefetchTicket&) = delete;
    PrefetchTicket& operator=(const PrefetchTicket&) = delete;
    PrefetchTicket(PrefetchTicket&& other) noexcept = default;

    PrefetchTicket& operator=(PrefetchTicket&& other) noexcept
    {
        if (this == &other)
            return *this;
        reset();
        m_control = std::move(other.m_control);
        return *this;
    }

    [[nodiscard]] static PrefetchTicket
    from_control_on_owner(std::unique_ptr<PrefetchTicketControl> control) noexcept
    {
        assert(control != nullptr);
        control->assert_owner_thread();
        assert(control->request_id_on_owner().valid());
        assert(control->generation_on_owner().valid());
        return PrefetchTicket(std::move(control));
    }

    [[nodiscard]] explicit operator bool() const noexcept { return m_control != nullptr; }

    [[nodiscard]] AssetRequestId request_id() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->request_id_on_owner();
    }

    [[nodiscard]] PrefetchGenerationId generation() const noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        return m_control->generation_on_owner();
    }

    void cancel() noexcept
    {
        assert(m_control != nullptr);
        m_control->assert_owner_thread();
        m_control->cancel_on_owner();
    }

    void reset() noexcept
    {
        if (m_control == nullptr)
            return;
        m_control->assert_owner_thread();
        m_control->cancel_on_owner();
        m_control.reset();
    }

private:
    explicit PrefetchTicket(std::unique_ptr<PrefetchTicketControl> control) noexcept
        : m_control(std::move(control))
    {
    }

    std::unique_ptr<PrefetchTicketControl> m_control;
};

static_assert(!std::is_copy_constructible_v<PrefetchTicket>);

} // namespace noveltea::assets
