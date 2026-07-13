#include "noveltea/core/shared_evaluator.hpp"

#include <algorithm>
#include <cmath>
#include <type_traits>
#include <utility>

namespace noveltea::core {
namespace {

Diagnostics evaluation_error(std::string code, std::string message)
{
    return Diagnostics{Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

bool is_number(const RuntimeValue& value) noexcept
{
    return std::holds_alternative<std::int64_t>(value) || std::holds_alternative<double>(value);
}

bool finite_number(const RuntimeValue& value) noexcept
{
    const auto* number = std::get_if<double>(&value);
    return number == nullptr || std::isfinite(*number);
}

long double number_value(const RuntimeValue& value) noexcept
{
    if (const auto* integer = std::get_if<std::int64_t>(&value))
        return static_cast<long double>(*integer);
    return static_cast<long double>(*std::get_if<double>(&value));
}

bool values_match_declaration(const compiled::VariableDefinition& declaration,
                              const RuntimeValue& left, const RuntimeValue& right) noexcept
{
    if (!finite_number(left) || !finite_number(right))
        return false;
    return std::visit(
        [&left, &right](const auto& type) {
            using T = std::decay_t<decltype(type)>;
            if constexpr (std::is_same_v<T, BooleanPropertyType>)
                return std::holds_alternative<bool>(left) && std::holds_alternative<bool>(right);
            else if constexpr (std::is_same_v<T, IntegerPropertyType>)
                return std::holds_alternative<std::int64_t>(left) &&
                       std::holds_alternative<std::int64_t>(right);
            else if constexpr (std::is_same_v<T, NumberPropertyType>)
                return is_number(left) && is_number(right);
            else if constexpr (std::is_same_v<T, StringPropertyType>)
                return std::holds_alternative<std::string>(left) &&
                       std::holds_alternative<std::string>(right);
            else {
                const auto* left_text = std::get_if<std::string>(&left);
                const auto* right_text = std::get_if<std::string>(&right);
                return left_text != nullptr && right_text != nullptr &&
                       std::find(type.values.begin(), type.values.end(), *left_text) !=
                           type.values.end() &&
                       std::find(type.values.begin(), type.values.end(), *right_text) !=
                           type.values.end();
            }
        },
        declaration.value_type);
}

Result<bool, Diagnostics> compare_values(const compiled::VariableDefinition& declaration,
                                         const VariableValueComparison& comparison,
                                         const RuntimeValue& current)
{
    if (!values_match_declaration(declaration, current, comparison.value))
        return Result<bool, Diagnostics>::failure(evaluation_error(
            "execution.invalid_comparison_value",
            "Variable comparison contains a missing, non-finite, or type-incompatible value"));

    int order = 0;
    if (is_number(current)) {
        const auto left = number_value(current);
        const auto right = number_value(comparison.value);
        order = left < right ? -1 : (left > right ? 1 : 0);
    } else if (const auto* left = std::get_if<std::string>(&current)) {
        const auto& right = *std::get_if<std::string>(&comparison.value);
        order = *left < right ? -1 : (*left > right ? 1 : 0);
    } else if (const auto* left = std::get_if<bool>(&current)) {
        const bool right = *std::get_if<bool>(&comparison.value);
        order = *left == right ? 0 : (*left ? 1 : -1);
    } else {
        return Result<bool, Diagnostics>::failure(evaluation_error(
            "execution.invalid_comparison_value", "Null variables cannot be compared"));
    }

    switch (comparison.operation) {
    case ValueComparisonOperator::Equal:
        return Result<bool, Diagnostics>::success(order == 0);
    case ValueComparisonOperator::NotEqual:
        return Result<bool, Diagnostics>::success(order != 0);
    case ValueComparisonOperator::Less:
    case ValueComparisonOperator::LessEqual:
    case ValueComparisonOperator::Greater:
    case ValueComparisonOperator::GreaterEqual:
        if (std::holds_alternative<BooleanPropertyType>(declaration.value_type) ||
            std::holds_alternative<EnumPropertyType>(declaration.value_type))
            return Result<bool, Diagnostics>::failure(evaluation_error(
                "execution.invalid_comparison_operator",
                "Ordered comparison is incompatible with the variable declaration"));
        if (comparison.operation == ValueComparisonOperator::Less)
            return Result<bool, Diagnostics>::success(order < 0);
        if (comparison.operation == ValueComparisonOperator::LessEqual)
            return Result<bool, Diagnostics>::success(order <= 0);
        if (comparison.operation == ValueComparisonOperator::Greater)
            return Result<bool, Diagnostics>::success(order > 0);
        return Result<bool, Diagnostics>::success(order >= 0);
    }
    return Result<bool, Diagnostics>::failure(evaluation_error(
        "execution.invalid_comparison_operator", "Variable comparison operator is invalid"));
}

const std::string* localized_value(const compiled::Localization& localization,
                                   std::string_view locale, std::string_view key) noexcept
{
    const auto catalog = std::find_if(
        localization.catalogs.begin(), localization.catalogs.end(),
        [locale](const compiled::LocalizationCatalog& value) { return value.locale == locale; });
    if (catalog == localization.catalogs.end())
        return nullptr;
    const auto entry =
        std::find_if(catalog->entries.begin(), catalog->entries.end(),
                     [key](const compiled::LocalizationEntry& value) { return value.key == key; });
    return entry == catalog->entries.end() ? nullptr : &entry->value;
}

} // namespace

Result<bool, Diagnostics> SharedPrimitiveEvaluator::evaluate(const Condition& condition) const
{
    return std::visit(
        [this](const auto& value) -> Result<bool, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, Always>) {
                return Result<bool, Diagnostics>::success(true);
            } else if constexpr (std::is_same_v<T, VariableComparison>) {
                return std::visit(
                    [this](const auto& comparison) -> Result<bool, Diagnostics> {
                        const auto* declaration = m_project.find_variable(comparison.variable_id);
                        if (declaration == nullptr)
                            return Result<bool, Diagnostics>::failure(
                                evaluation_error("execution.unknown_variable",
                                                 "Condition references an undeclared variable '" +
                                                     comparison.variable_id.text() + "'"));
                        auto current = m_state.variable(m_project, comparison.variable_id);
                        const auto* current_value = current.value_if();
                        if (current_value == nullptr)
                            return Result<bool, Diagnostics>::failure(current.error());
                        using C = std::decay_t<decltype(comparison)>;
                        if constexpr (std::is_same_v<C, VariableValueComparison>) {
                            return compare_values(*declaration, comparison, *current_value);
                        } else {
                            const auto* boolean = std::get_if<bool>(current_value);
                            if (boolean == nullptr)
                                return Result<bool, Diagnostics>::failure(evaluation_error(
                                    "execution.invalid_truthiness_value",
                                    "Truthy and Falsy conditions require a Boolean variable"));
                            if (comparison.operation != TruthinessOperator::Truthy &&
                                comparison.operation != TruthinessOperator::Falsy)
                                return Result<bool, Diagnostics>::failure(
                                    evaluation_error("execution.invalid_comparison_operator",
                                                     "Variable truthiness operator is invalid"));
                            const bool expected =
                                comparison.operation == TruthinessOperator::Truthy;
                            return Result<bool, Diagnostics>::success(*boolean == expected);
                        }
                    },
                    value);
            } else {
                return Result<bool, Diagnostics>::failure(evaluation_error(
                    "execution.lua_condition_requires_script_runtime",
                    "LuaPredicate requires the immediate script evaluation boundary"));
            }
        },
        condition);
}

Result<void, Diagnostics> SharedPrimitiveEvaluator::apply(const Effect& effect)
{
    return std::visit(
        [this](const auto& value) -> Result<void, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, SetVariable>)
                return m_state.set_variable(m_project, value.variable_id, value.value);
            else
                return Result<void, Diagnostics>::failure(evaluation_error(
                    "execution.lua_effect_requires_script_runtime",
                    "RunLuaEffect requires the yield-capable script invocation boundary"));
        },
        effect);
}

Result<std::string, Diagnostics>
SharedPrimitiveEvaluator::resolve(const TextSource& source, std::string_view runtime_locale) const
{
    return std::visit(
        [this, runtime_locale](const auto& value) -> Result<std::string, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, InlineText>) {
                return Result<std::string, Diagnostics>::success(value.value);
            } else if constexpr (std::is_same_v<T, LocalizedTextKey>) {
                const auto& localization = m_project.localization();
                if (!runtime_locale.empty()) {
                    if (const auto* resolved =
                            localized_value(localization, runtime_locale, value.value))
                        return Result<std::string, Diagnostics>::success(*resolved);
                }
                if (runtime_locale != localization.default_locale) {
                    if (const auto* resolved =
                            localized_value(localization, localization.default_locale, value.value))
                        return Result<std::string, Diagnostics>::success(*resolved);
                }
                if (localization.fallback_locale &&
                    runtime_locale != *localization.fallback_locale &&
                    localization.default_locale != *localization.fallback_locale) {
                    if (const auto* resolved = localized_value(
                            localization, *localization.fallback_locale, value.value))
                        return Result<std::string, Diagnostics>::success(*resolved);
                }
                return Result<std::string, Diagnostics>::failure(evaluation_error(
                    "execution.missing_localized_text",
                    "Localized text key '" + value.value + "' is unavailable for runtime locale '" +
                        std::string(runtime_locale) + "' and its configured fallbacks"));
            } else {
                return Result<std::string, Diagnostics>::failure(evaluation_error(
                    "execution.lua_text_requires_script_runtime",
                    "LuaTextExpression requires the immediate script evaluation boundary"));
            }
        },
        source);
}

Result<WaitEvaluation, Diagnostics> SharedPrimitiveEvaluator::begin(const WaitSpec& wait)
{
    return std::visit(
        [this](const auto& value) -> Result<WaitEvaluation, Diagnostics> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, ImmediateWait>) {
                return Result<WaitEvaluation, Diagnostics>::success(WaitCompleted{});
            } else if constexpr (std::is_same_v<T, InputWait>) {
                auto blocker = m_executor.block_top(FlowBlockerKind::Input);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, DurationWait>) {
                if (value.duration().count() == 0)
                    return Result<WaitEvaluation, Diagnostics>::success(WaitCompleted{});
                auto blocker = m_executor.block_duration(value);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, PresentationCompletionWait>) {
                auto blocker = m_executor.block_top(FlowBlockerKind::Presentation);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, AudioCompletionWait>) {
                auto blocker = m_executor.block_top(FlowBlockerKind::Audio);
                const auto* active = blocker.value_if();
                return active ? Result<WaitEvaluation, Diagnostics>::success(WaitBlocked{*active})
                              : Result<WaitEvaluation, Diagnostics>::failure(blocker.error());
            } else if constexpr (std::is_same_v<T, ChildFlowCompletionWait>) {
                return Result<WaitEvaluation, Diagnostics>::failure(evaluation_error(
                    "execution.child_flow_wait_requires_call",
                    "ChildFlow waits are created only by an atomic typed child call"));
            } else {
                return Result<WaitEvaluation, Diagnostics>::failure(
                    evaluation_error("execution.script_wait_requires_script_runtime",
                                     "Script waits require the script suspension boundary"));
            }
        },
        wait);
}

Result<void, Diagnostics> SharedPrimitiveEvaluator::complete(const FlowFrameId& owner,
                                                             const AnyFlowBlockerHandle& handle)
{
    return m_executor.resume_blocker(owner, handle);
}

Result<void, Diagnostics> SharedPrimitiveEvaluator::cancel(const FlowFrameId& owner,
                                                           const AnyFlowBlockerHandle& handle)
{
    return m_executor.cancel_blocker(owner, handle);
}

Result<bool, Diagnostics> SharedPrimitiveEvaluator::advance(const FlowFrameId& owner,
                                                            const DurationFlowBlockerHandle& handle,
                                                            std::chrono::milliseconds elapsed)
{
    return m_executor.advance_duration_blocker(owner, handle, elapsed);
}

} // namespace noveltea::core
