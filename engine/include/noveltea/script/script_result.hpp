#pragma once

#include <optional>
#include <string>
#include <utility>

namespace noveltea::script {

struct ScriptError {
    std::string message;
    std::string chunk;
    std::string traceback;
};

template <typename T>
struct ScriptResult {
    std::optional<T> value;
    std::optional<ScriptError> error;

    [[nodiscard]] explicit operator bool() const { return value.has_value() && !error.has_value(); }

    [[nodiscard]] static ScriptResult success(T result)
    {
        ScriptResult out;
        out.value = std::move(result);
        return out;
    }

    [[nodiscard]] static ScriptResult failure(ScriptError err)
    {
        ScriptResult out;
        out.error = std::move(err);
        return out;
    }
};

template <>
struct ScriptResult<void> {
    bool ok = false;
    std::optional<ScriptError> error;

    [[nodiscard]] explicit operator bool() const { return ok && !error.has_value(); }

    [[nodiscard]] static ScriptResult success()
    {
        ScriptResult out;
        out.ok = true;
        return out;
    }

    [[nodiscard]] static ScriptResult failure(ScriptError err)
    {
        ScriptResult out;
        out.error = std::move(err);
        return out;
    }
};

} // namespace noveltea::script
