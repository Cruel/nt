#pragma once
#include "noveltea/core/diagnostic.hpp"
#include <functional>
#include <optional>
#include <type_traits>
#include <utility>
namespace noveltea::core {
template<class T, class E> class Result {
public:
    [[nodiscard]] static Result success(T value) { return Result(std::move(value)); }
    [[nodiscard]] static Result failure(E error) { return Result(Failure{}, std::move(error)); }
    [[nodiscard]] explicit operator bool() const noexcept { return m_value.has_value(); }
    [[nodiscard]] bool has_value() const noexcept { return m_value.has_value(); }
    [[nodiscard]] T& value() & { return *m_value; }
    [[nodiscard]] const T& value() const& { return *m_value; }
    [[nodiscard]] T&& value() && { return std::move(*m_value); }
    [[nodiscard]] E& error() & { return *m_error; }
    [[nodiscard]] const E& error() const& { return *m_error; }
    template<class F>
    [[nodiscard]] auto
    transform(F&& function) const& -> Result<std::invoke_result_t<F, const T&>, E>
    {
        using Output = Result<std::invoke_result_t<F, const T&>, E>;
        return m_value ? Output::success(std::invoke(std::forward<F>(function), *m_value))
                       : Output::failure(*m_error);
    }
    template<class F> [[nodiscard]] auto and_then(F&& function) const&
    {
        using Output = std::invoke_result_t<F, const T&>;
        return m_value ? std::invoke(std::forward<F>(function), *m_value)
                       : Output::failure(*m_error);
    }

private:
    struct Failure {};
    explicit Result(T value) : m_value(std::move(value)) {}
    Result(Failure, E error) : m_error(std::move(error)) {}
    std::optional<T> m_value;
    std::optional<E> m_error;
};
template<class E> class Result<void, E> {
public:
    [[nodiscard]] static Result success() { return Result(true, std::nullopt); }
    [[nodiscard]] static Result failure(E error) { return Result(false, std::move(error)); }
    [[nodiscard]] explicit operator bool() const noexcept { return m_ok; }
    [[nodiscard]] bool has_value() const noexcept { return m_ok; }
    [[nodiscard]] E& error() & { return *m_error; }
    [[nodiscard]] const E& error() const& { return *m_error; }
    template<class F> [[nodiscard]] auto and_then(F&& function) const
    {
        using Output = std::invoke_result_t<F>;
        return m_ok ? std::invoke(std::forward<F>(function)) : Output::failure(*m_error);
    }

private:
    Result(bool ok, std::optional<E> error) : m_ok(ok), m_error(std::move(error)) {}
    bool m_ok = false;
    std::optional<E> m_error;
};
template<class T> using DiagnosticResult = Result<T, Diagnostic>;
} // namespace noveltea::core
