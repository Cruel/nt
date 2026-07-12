#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/result.hpp"

#include <nlohmann/json.hpp>

#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>

namespace noveltea::core::json_access {

[[nodiscard]] inline const nlohmann::json* member(const nlohmann::json& object,
                                                  std::string_view key) noexcept
{
    if (!object.is_object())
        return nullptr;
    const auto iterator = object.find(std::string(key));
    return iterator == object.end() ? nullptr : &*iterator;
}

[[nodiscard]] inline nlohmann::json* member(nlohmann::json& object, std::string_view key) noexcept
{
    if (!object.is_object())
        return nullptr;
    const auto iterator = object.find(std::string(key));
    return iterator == object.end() ? nullptr : &*iterator;
}

[[nodiscard]] inline const nlohmann::json* element(const nlohmann::json& array,
                                                   std::size_t index) noexcept
{
    if (!array.is_array() || index >= array.size())
        return nullptr;
    return &array[index];
}

[[nodiscard]] inline nlohmann::json* element(nlohmann::json& array, std::size_t index) noexcept
{
    if (!array.is_array() || index >= array.size())
        return nullptr;
    return &array[index];
}

template<class T> [[nodiscard]] std::optional<T> get(const nlohmann::json& value) noexcept
{
    using Value = std::remove_cv_t<std::remove_reference_t<T>>;

    if constexpr (std::is_same_v<Value, nlohmann::json>) {
        return std::optional<Value>(value);
    } else if constexpr (std::is_same_v<Value, std::string>) {
        if (const auto* string = value.get_ptr<const nlohmann::json::string_t*>())
            return *string;
    } else if constexpr (std::is_same_v<Value, std::string_view>) {
        if (const auto* string = value.get_ptr<const nlohmann::json::string_t*>())
            return std::string_view(*string);
    } else if constexpr (std::is_same_v<Value, bool>) {
        if (const auto* boolean = value.get_ptr<const nlohmann::json::boolean_t*>())
            return *boolean;
    } else if constexpr (std::is_integral_v<Value> && std::is_signed_v<Value> &&
                         !std::is_same_v<Value, bool>) {
        if (const auto* integer = value.get_ptr<const nlohmann::json::number_integer_t*>()) {
            if (*integer >= static_cast<nlohmann::json::number_integer_t>(
                                std::numeric_limits<Value>::min()) &&
                *integer <= static_cast<nlohmann::json::number_integer_t>(
                                std::numeric_limits<Value>::max())) {
                return static_cast<Value>(*integer);
            }
        }
        if (const auto* unsigned_integer =
                value.get_ptr<const nlohmann::json::number_unsigned_t*>()) {
            if (*unsigned_integer <=
                static_cast<nlohmann::json::number_unsigned_t>(std::numeric_limits<Value>::max())) {
                return static_cast<Value>(*unsigned_integer);
            }
        }
    } else if constexpr (std::is_integral_v<Value> && std::is_unsigned_v<Value>) {
        if (const auto* unsigned_integer =
                value.get_ptr<const nlohmann::json::number_unsigned_t*>()) {
            if (*unsigned_integer <=
                static_cast<nlohmann::json::number_unsigned_t>(std::numeric_limits<Value>::max())) {
                return static_cast<Value>(*unsigned_integer);
            }
        }
        if (const auto* integer = value.get_ptr<const nlohmann::json::number_integer_t*>()) {
            if (*integer >= 0 && static_cast<nlohmann::json::number_unsigned_t>(*integer) <=
                                     static_cast<nlohmann::json::number_unsigned_t>(
                                         std::numeric_limits<Value>::max())) {
                return static_cast<Value>(*integer);
            }
        }
    } else if constexpr (std::is_floating_point_v<Value>) {
        if (const auto* floating = value.get_ptr<const nlohmann::json::number_float_t*>())
            return static_cast<Value>(*floating);
        if (const auto* integer = value.get_ptr<const nlohmann::json::number_integer_t*>())
            return static_cast<Value>(*integer);
        if (const auto* unsigned_integer =
                value.get_ptr<const nlohmann::json::number_unsigned_t*>()) {
            return static_cast<Value>(*unsigned_integer);
        }
    } else {
        static_assert(!sizeof(Value), "json_access::get does not support this type");
    }

    return std::nullopt;
}

template<class T> [[nodiscard]] T get_or(const nlohmann::json& value, T fallback) noexcept
{
    auto result = get<T>(value);
    return result ? std::move(*result) : std::move(fallback);
}

template<class T>
[[nodiscard]] std::optional<T> member_as(const nlohmann::json& object,
                                         std::string_view key) noexcept
{
    const auto* value = member(object, key);
    return value ? get<T>(*value) : std::nullopt;
}

template<class T>
[[nodiscard]] T value_or(const nlohmann::json& object, std::string_view key, T fallback) noexcept
{
    auto result = member_as<T>(object, key);
    return result ? std::move(*result) : std::move(fallback);
}

template<class T>
[[nodiscard]] DiagnosticResult<T> require(const nlohmann::json& value, std::string code,
                                          std::string message, std::string source_path = {},
                                          std::string json_pointer = {})
{
    if (auto result = get<T>(value))
        return DiagnosticResult<T>::success(std::move(*result));
    return DiagnosticResult<T>::failure(Diagnostic{std::move(code),
                                                   std::move(message),
                                                   ErrorSeverity::Error,
                                                   std::move(source_path),
                                                   std::move(json_pointer),
                                                   {}});
}

template<class T>
[[nodiscard]] DiagnosticResult<T>
require_member(const nlohmann::json& object, std::string_view key, std::string code,
               std::string message, std::string source_path = {}, std::string json_pointer = {})
{
    const auto* value = member(object, key);
    if (!value) {
        return DiagnosticResult<T>::failure(Diagnostic{std::move(code),
                                                       std::move(message),
                                                       ErrorSeverity::Error,
                                                       std::move(source_path),
                                                       std::move(json_pointer),
                                                       {}});
    }
    return require<T>(*value, std::move(code), std::move(message), std::move(source_path),
                      std::move(json_pointer));
}

} // namespace noveltea::core::json_access
