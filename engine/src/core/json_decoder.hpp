#pragma once

#include "noveltea/core/diagnostic.hpp"
#include "noveltea/core/json_access.hpp"

#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace noveltea::core {

struct JsonDecoderCodes {
    std::string missing_field;
    std::string type;
    std::string unknown_field;
    std::string invalid_number;
    std::string invalid_id;
    std::string unknown_value;
};

class JsonDecoder {
public:
    JsonDecoder(std::string source_path, JsonDecoderCodes codes)
        : m_source_path(std::move(source_path)), m_codes(std::move(codes))
    {
    }

    void error(std::string_view code, std::string message, std::string pointer)
    {
        m_diagnostics.push_back(Diagnostic{.code = std::string(code),
                                           .message = std::move(message),
                                           .severity = ErrorSeverity::Error,
                                           .source_path = m_source_path,
                                           .json_pointer = std::move(pointer)});
    }

    bool object(const nlohmann::json& value, std::string_view pointer,
                std::initializer_list<std::string_view> fields)
    {
        if (!value.is_object()) {
            error(m_codes.type, "Expected an object.", std::string(pointer));
            return false;
        }
        for (auto iterator = value.begin(); iterator != value.end(); ++iterator) {
            const std::string& key = iterator.key();
            if (std::find(fields.begin(), fields.end(), std::string_view(key)) == fields.end()) {
                error(m_codes.unknown_field, "Unknown field '" + key + "'.", child(pointer, key));
            }
        }
        return true;
    }

    const nlohmann::json* member(const nlohmann::json& object, std::string_view key,
                                 std::string_view pointer)
    {
        const auto* value = json_access::member(object, key);
        if (!value) {
            error(m_codes.missing_field, "Missing required field '" + std::string(key) + "'.",
                  child(pointer, key));
        }
        return value;
    }

    const nlohmann::json* required(const nlohmann::json& object, std::string_view key,
                                   std::string_view pointer)
    {
        return member(object, key, pointer);
    }

    std::optional<std::string> string(const nlohmann::json& value, std::string_view pointer,
                                      bool nonempty = false, bool trim_nonempty = false)
    {
        auto decoded = json_access::get<std::string>(value);
        if (!decoded) {
            error(m_codes.type, "Expected a string.", std::string(pointer));
            return std::nullopt;
        }

        bool has_content = !decoded->empty();
        if (trim_nonempty) {
            has_content =
                std::any_of(decoded->begin(), decoded->end(), [](unsigned char character) {
                    return character != ' ' && character != '\t' && character != '\n' &&
                           character != '\r';
                });
        }
        if ((nonempty || trim_nonempty) && !has_content) {
            error(m_codes.type, "Expected a non-empty string.", std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    std::optional<bool> boolean(const nlohmann::json& value, std::string_view pointer)
    {
        auto decoded = json_access::get<bool>(value);
        if (!decoded)
            error(m_codes.type, "Expected a boolean.", std::string(pointer));
        return decoded;
    }

    std::optional<double> finite_number(const nlohmann::json& value, std::string_view pointer)
    {
        auto decoded = json_access::get<double>(value);
        if (!decoded) {
            error(m_codes.type, "Expected a number.", std::string(pointer));
            return std::nullopt;
        }
        if (!std::isfinite(*decoded)) {
            error(m_codes.invalid_number.empty() ? m_codes.type : m_codes.invalid_number,
                  "Number must be finite.", std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    template<class T>
    std::optional<T> integer(const nlohmann::json& value, std::string_view pointer,
                             bool positive = false)
    {
        auto decoded = json_access::get<T>(value);
        if (!decoded || (positive && *decoded == 0)) {
            error(m_codes.type,
                  positive ? "Expected a positive integer."
                           : "Expected a nonnegative integer in range.",
                  std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    template<class T>
    std::optional<T> unsigned_integer(const nlohmann::json& value, std::string_view pointer,
                                      bool positive = false)
    {
        auto decoded = json_access::get<T>(value);
        if (!decoded) {
            error(m_codes.type, "Expected a nonnegative integer in range.", std::string(pointer));
            return std::nullopt;
        }
        if (positive && *decoded == 0) {
            error(m_codes.invalid_number.empty() ? m_codes.type : m_codes.invalid_number,
                  "Expected a positive integer.", std::string(pointer));
            return std::nullopt;
        }
        return decoded;
    }

    template<class Id> std::optional<Id> id(const nlohmann::json& value, std::string_view pointer)
    {
        auto text = string(value, pointer, true);
        if (!text)
            return std::nullopt;
        auto result = Id::create(std::move(*text));
        if (!result) {
            error(m_codes.invalid_id, result.error().front().message, std::string(pointer));
            return std::nullopt;
        }
        return std::move(*result.value_if());
    }

    template<class Id> struct OptionalId {
        bool valid = false;
        std::optional<Id> value;
        [[nodiscard]] explicit operator bool() const noexcept { return valid; }
    };

    template<class Id>
    OptionalId<Id> optional_id(const nlohmann::json& value, std::string_view pointer)
    {
        if (value.is_null())
            return OptionalId<Id>{true, std::nullopt};
        auto result = id<Id>(value, pointer);
        return result ? OptionalId<Id>{true, std::move(result)}
                      : OptionalId<Id>{false, std::nullopt};
    }

    template<class Enum>
    std::optional<Enum> enumeration(const nlohmann::json& value, std::string_view pointer,
                                    std::initializer_list<std::pair<std::string_view, Enum>> values)
    {
        auto text = string(value, pointer);
        if (!text)
            return std::nullopt;
        for (const auto& [name, result] : values) {
            if (*text == name)
                return result;
        }
        error(m_codes.unknown_value, "Unknown value '" + *text + "'.", std::string(pointer));
        return std::nullopt;
    }

    template<class T, class Function>
    std::optional<std::vector<T>> array(const nlohmann::json& value, std::string_view pointer,
                                        Function&& function)
    {
        if (!value.is_array()) {
            error(m_codes.type, "Expected an array.", std::string(pointer));
            return std::nullopt;
        }
        std::vector<T> output;
        output.reserve(value.size());
        for (std::size_t index_value = 0; index_value < value.size(); ++index_value) {
            const auto* element = json_access::element(value, index_value);
            if (!element)
                continue;
            auto decoded = function(*element, index(pointer, index_value));
            if (decoded)
                output.push_back(std::move(*decoded));
        }
        return output;
    }

    [[nodiscard]] bool failed() const noexcept { return !m_diagnostics.empty(); }
    [[nodiscard]] Diagnostics take() { return std::move(m_diagnostics); }
    [[nodiscard]] Diagnostics take_diagnostics() { return std::move(m_diagnostics); }

    [[nodiscard]] static std::string child(std::string_view parent, std::string_view name)
    {
        std::string result(parent);
        result.push_back('/');
        for (const char character : name) {
            if (character == '~')
                result += "~0";
            else if (character == '/')
                result += "~1";
            else
                result.push_back(character);
        }
        return result;
    }

    [[nodiscard]] static std::string index(std::string_view parent, std::size_t value)
    {
        return child(parent, std::to_string(value));
    }

private:
    std::string m_source_path;
    JsonDecoderCodes m_codes;
    Diagnostics m_diagnostics;
};

} // namespace noveltea::core
