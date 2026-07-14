#include "noveltea/core/diagnostic.hpp"

#include "noveltea/core/runtime_diagnostic_context.hpp"

namespace noveltea::core {

bool Diagnostic::operator==(const Diagnostic& other) const
{
    const bool contexts_equal =
        (!runtime_context && !other.runtime_context) ||
        (runtime_context && other.runtime_context && *runtime_context == *other.runtime_context);
    return code == other.code && message == other.message && severity == other.severity &&
           source_path == other.source_path && json_pointer == other.json_pointer &&
           causes == other.causes && contexts_equal;
}

} // namespace noveltea::core
