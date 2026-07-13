#pragma once
#include "noveltea/core/diagnostic.hpp"
#include <cassert>
#include <functional>
#include <type_traits>
#include <utility>
#include <variant>
namespace noveltea::core {
template<class T, class E> class Result {
public:
    [[nodiscard]] static Result success(T value) { return Result(Value{std::move(value)}); }
    [[nodiscard]] static Result failure(E error) { return Result(Error{std::move(error)}); }
    [[nodiscard]] explicit operator bool() const noexcept { return has_value(); }
    [[nodiscard]] bool has_value() const noexcept
    {
        return std::holds_alternative<Value>(m_storage);
    }
    [[nodiscard]] T& value() &
    {
        assert(has_value());
        return std::get<Value>(m_storage).value;
    }
    [[nodiscard]] const T& value() const&
    {
        assert(has_value());
        return std::get<Value>(m_storage).value;
    }
    [[nodiscard]] T&& value() &&
    {
        assert(has_value());
        return std::move(std::get<Value>(m_storage).value);
    }
    [[nodiscard]] T* value_if() noexcept
    {
        auto* value = std::get_if<Value>(&m_storage);
        return value == nullptr ? nullptr : &value->value;
    }
    [[nodiscard]] const T* value_if() const noexcept
    {
        const auto* value = std::get_if<Value>(&m_storage);
        return value == nullptr ? nullptr : &value->value;
    }
    [[nodiscard]] E& error() &
    {
        assert(!has_value());
        return std::get<Error>(m_storage).error;
    }
    [[nodiscard]] const E& error() const&
    {
        assert(!has_value());
        return std::get<Error>(m_storage).error;
    }
    template<class F>
    [[nodiscard]] auto
    transform(F&& function) const& -> Result<std::invoke_result_t<F, const T&>, E>
    {
        using Output = Result<std::invoke_result_t<F, const T&>, E>;
        return has_value() ? Output::success(std::invoke(std::forward<F>(function), value()))
                           : Output::failure(error());
    }
    template<class F> [[nodiscard]] auto and_then(F&& function) const&
    {
        using Output = std::invoke_result_t<F, const T&>;
        return has_value() ? std::invoke(std::forward<F>(function), value())
                           : Output::failure(error());
    }

    template<class F> [[nodiscard]] auto transform_error(F&& function) const&
    {
        using OutputError = std::invoke_result_t<F, const E&>;
        using Output = Result<T, OutputError>;
        return has_value() ? Output::success(value())
                           : Output::failure(std::invoke(std::forward<F>(function), error()));
    }

private:
    struct Value {
        T value;
    };
    struct Error {
        E error;
    };
    explicit Result(Value value) : m_storage(std::move(value)) {}
    explicit Result(Error error) : m_storage(std::move(error)) {}
    std::variant<Value, Error> m_storage;
};
template<class E> class Result<void, E> {
public:
    [[nodiscard]] static Result success() { return Result(std::monostate{}); }
    [[nodiscard]] static Result failure(E error) { return Result(std::move(error)); }
    [[nodiscard]] explicit operator bool() const noexcept { return m_ok; }
    [[nodiscard]] bool has_value() const noexcept { return m_ok; }
    [[nodiscard]] E& error() &
    {
        assert(!m_ok);
        return std::get<E>(m_storage);
    }
    [[nodiscard]] const E& error() const&
    {
        assert(!m_ok);
        return std::get<E>(m_storage);
    }
    template<class F> [[nodiscard]] auto and_then(F&& function) const
    {
        using Output = std::invoke_result_t<F>;
        return m_ok ? std::invoke(std::forward<F>(function)) : Output::failure(error());
    }

    template<class F> [[nodiscard]] auto transform_error(F&& function) const&
    {
        using OutputError = std::invoke_result_t<F, const E&>;
        using Output = Result<void, OutputError>;
        return m_ok ? Output::success()
                    : Output::failure(std::invoke(std::forward<F>(function), error()));
    }

private:
    explicit Result(std::monostate value) : m_ok(true), m_storage(value) {}
    explicit Result(E error) : m_ok(false), m_storage(std::move(error)) {}
    bool m_ok;
    std::variant<std::monostate, E> m_storage;
};
template<class T> using DiagnosticResult = Result<T, Diagnostic>;
} // namespace noveltea::core
