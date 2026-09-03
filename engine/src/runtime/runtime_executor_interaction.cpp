#include "noveltea/runtime/runtime_executor.hpp"

#include <algorithm>
#include <type_traits>
#include <utility>

namespace noveltea::runtime {
namespace {

core::Diagnostics interaction_error(std::string code, std::string message)
{
    return core::Diagnostics{
        core::Diagnostic{.code = std::move(code), .message = std::move(message)}};
}

std::string_view undefined_interaction_message(std::string_view locale) noexcept
{
    if (locale.starts_with("es"))
        return "No pasa nada.";
    if (locale.starts_with("fr"))
        return "Rien ne se passe.";
    if (locale.starts_with("de"))
        return "Nichts passiert.";
    if (locale.starts_with("ja"))
        return "何も起こらない。";
    return "Nothing happens.";
}

const core::compiled::InteractionProgram* program_for(const core::CompiledProject& project,
                                                      const core::InteractionProgramRef& reference)
{
    return std::visit(
        [&project](const auto& value) -> const core::compiled::InteractionProgram* {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::InteractionRuleProgramRef>) {
                const auto* interaction = project.find_interaction(value.interaction);
                if (interaction == nullptr)
                    return nullptr;
                const auto found =
                    std::find_if(interaction->rules.begin(), interaction->rules.end(),
                                 [&value](const core::compiled::InteractionRule& rule) {
                                     return rule.id == value.rule;
                                 });
                return found == interaction->rules.end() ? nullptr : &found->program;
            } else if constexpr (std::is_same_v<T, core::VerbDefaultProgramRef>) {
                const auto* verb = project.find_verb(value.verb);
                return verb == nullptr ? nullptr : &verb->default_program;
            } else {
                const auto& fallback = project.undefined_interaction_program();
                return fallback ? &*fallback : nullptr;
            }
        },
        reference);
}

std::optional<core::InteractionInstructionId>
first_instruction(const core::compiled::InteractionProgram& program)
{
    if (program.instructions.empty())
        return std::nullopt;
    return program.instructions.front().id;
}

const core::GameplayCommand* find_instruction_in(std::span<const core::GameplayCommand> commands,
                                                 const core::InteractionInstructionId& id)
{
    for (const auto& command : commands) {
        if (command.id == id)
            return &command;
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&command.value)) {
            if (const auto* found = find_instruction_in(branch->then_commands, id))
                return found;
            if (const auto* found = find_instruction_in(branch->else_commands, id))
                return found;
        }
    }
    return nullptr;
}

const core::GameplayCommand* find_instruction(const core::compiled::InteractionProgram& program,
                                              const core::InteractionInstructionId& id)
{
    return find_instruction_in(program.instructions, id);
}

std::optional<core::InteractionInstructionId>
next_instruction_in(std::span<const core::GameplayCommand> commands,
                    const core::InteractionInstructionId& id,
                    std::optional<core::InteractionInstructionId> after_commands)
{
    for (std::size_t index = 0; index < commands.size(); ++index) {
        const auto successor =
            index + 1 < commands.size()
                ? std::optional<core::InteractionInstructionId>{commands[index + 1].id}
                : after_commands;
        if (commands[index].id == id)
            return successor;
        if (const auto* branch = std::get_if<core::IfGameplayCommand>(&commands[index].value)) {
            if (find_instruction_in(branch->then_commands, id))
                return next_instruction_in(branch->then_commands, id, successor);
            if (find_instruction_in(branch->else_commands, id))
                return next_instruction_in(branch->else_commands, id, successor);
        }
    }
    return std::nullopt;
}

std::optional<core::InteractionInstructionId>
next_instruction(const core::compiled::InteractionProgram& program,
                 const core::InteractionInstructionId& id)
{
    return next_instruction_in(program.instructions, id, std::nullopt);
}

} // namespace

core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>
RuntimeExecutor::verb_offers(const core::compiled::InteractionSubject& subject,
                             std::string_view runtime_locale)
{
    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    if (room_mode == nullptr || !m_state.flow_stack().empty())
        return core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>::success({});

    if (!m_room_presentation || m_room_presentation_dirty ||
        m_room_presentation->presentation.visit.room != room_mode->room) {
        auto settled = room_view(runtime_locale);
        if (!settled)
            return core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>::failure(
                settled.error());
    }
    if (std::find(m_room_presentation->eligible_subjects.begin(),
                  m_room_presentation->eligible_subjects.end(),
                  subject) == m_room_presentation->eligible_subjects.end())
        return core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>::success({});

    const auto subject_family = [](const core::compiled::InteractionSubject& value) {
        if (std::holds_alternative<core::compiled::CharacterInteractionSubject>(value))
            return core::compiled::SubjectFamily::Character;
        if (std::holds_alternative<core::compiled::InteractableInteractionSubject>(value))
            return core::compiled::SubjectFamily::Interactable;
        return core::compiled::SubjectFamily::Feature;
    };
    const auto subject_identity = [](const core::compiled::InteractionSubject& value) {
        return std::visit(
            [](const auto& typed) -> std::string {
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                    return std::string("character:") + typed.character.text();
                else if constexpr (std::is_same_v<T,
                                                  core::compiled::InteractableInteractionSubject>)
                    return std::string("interactable:") + typed.interactable.text();
                else
                    return std::visit(
                        [](const auto& feature) {
                            using F = std::decay_t<decltype(feature)>;
                            if constexpr (std::is_same_v<F, core::RoomFeatureRef>)
                                return std::string("room:") + feature.room.text() + "#" +
                                       feature.feature_id.text();
                            else
                                return std::string("interactable:") + feature.interactable.text() +
                                       "#" + feature.feature_id.text();
                        },
                        typed.feature);
            },
            value);
    };
    const auto has_trait = [this](const core::compiled::InteractionSubject& value,
                                  const core::TraitId& trait) {
        const auto* traits = std::visit(
            [this](const auto& typed) -> const std::vector<core::TraitId>* {
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(typed.character);
                    return config ? &config->identity.traits : nullptr;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(typed.interactable);
                    return config ? &config->identity.traits : nullptr;
                } else {
                    return std::visit(
                        [this](const auto& feature) -> const std::vector<core::TraitId>* {
                            const auto* owner = m_world.resolved_configuration([&]() {
                                if constexpr (std::is_same_v<std::decay_t<decltype(feature)>,
                                                             core::RoomFeatureRef>)
                                    return feature.room;
                                else
                                    return feature.interactable;
                            }());
                            if (!owner)
                                return nullptr;
                            const auto found =
                                std::find_if(owner->features.begin(), owner->features.end(),
                                             [&](const auto& item) {
                                                 return item.identity.id == feature.feature_id;
                                             });
                            return found == owner->features.end() ? nullptr
                                                                  : &found->identity.traits;
                        },
                        typed.feature);
                }
            },
            value);
        return traits && std::find(traits->begin(), traits->end(), trait) != traits->end();
    };
    const auto selector_matches = [&](const core::compiled::SubjectSelector& selector) {
        return std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::AnySubjectSelector>)
                    return true;
                else if constexpr (std::is_same_v<T, core::compiled::FamilySubjectSelector>)
                    return value.family == subject_family(subject);
                else if constexpr (std::is_same_v<T, core::compiled::TraitSubjectSelector>)
                    return has_trait(subject, value.trait);
                else if constexpr (std::is_same_v<
                                       T, core::compiled::InteractableDefinitionSubjectSelector>) {
                    const auto* interactable =
                        std::get_if<core::compiled::InteractableInteractionSubject>(&subject);
                    return interactable && m_world.matches_interactable(
                                               interactable->interactable,
                                               InteractableMatcher{value.interactable_definition});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableFeatureSubjectSelector>) {
                    const auto* feature =
                        std::get_if<core::compiled::FeatureInteractionSubject>(&subject);
                    const auto* interactable =
                        feature ? std::get_if<core::InteractableFeatureRef>(&feature->feature)
                                : nullptr;
                    return interactable && interactable->feature_id == value.feature_id &&
                           m_world.matches_interactable(
                               interactable->interactable,
                               InteractableMatcher{value.interactable_definition});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::QualifiedPatternSubjectSelector>) {
                    if (value.family != subject_family(subject))
                        return false;
                    const auto identity = subject_identity(subject);
                    const auto prefix = value.pattern.substr(0, value.pattern.size() - 1);
                    return identity.starts_with(prefix);
                } else
                    return value.subject == subject;
            },
            selector);
    };
    struct Specificity {
        int tier = 0;
        std::size_t detail = 0;
        auto operator<=>(const Specificity&) const = default;
    };
    const auto selector_specificity = [&](const core::compiled::SubjectSelector& selector) {
        return std::visit(
            [](const auto& value) -> Specificity {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::ExactSubjectSelector>)
                    return {5, 0};
                else if constexpr (std::is_same_v<T,
                                                  core::compiled::QualifiedPatternSubjectSelector>)
                    return {4, value.pattern.size()};
                else if constexpr (std::is_same_v<T, core::compiled::TraitSubjectSelector> ||
                                   std::is_same_v<
                                       T, core::compiled::InteractableDefinitionSubjectSelector> ||
                                   std::is_same_v<
                                       T, core::compiled::InteractableFeatureSubjectSelector>)
                    return {3, 0};
                else if constexpr (std::is_same_v<T, core::compiled::FamilySubjectSelector>)
                    return {2, 0};
                else
                    return {1, 0};
            },
            selector);
    };
    const auto matching_specificity =
        [&](const std::vector<core::compiled::SubjectSelector>& selectors)
        -> std::optional<Specificity> {
        std::optional<Specificity> best;
        for (const auto& selector : selectors) {
            if (!selector_matches(selector))
                continue;
            const auto specificity = selector_specificity(selector);
            if (!best || specificity > *best)
                best = specificity;
        }
        return best;
    };

    struct Candidate {
        core::VerbSlotId slot;
        const core::Condition* condition = nullptr;
        std::int64_t rank = 0;
        bool primary = false;
        Specificity specificity;
        std::string stable_id;
    };
    std::vector<core::VerbOfferView> resolved;
    for (const auto& verb : m_project.verbs()) {
        auto available = evaluate(verb.availability);
        const auto* availability_value = available.value_if();
        if (availability_value == nullptr)
            return core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>::failure(
                available.error());
        if (!*availability_value)
            continue;

        std::optional<Candidate> winner;
        const auto consider = [&](Candidate candidate) {
            if (!winner || candidate.specificity > winner->specificity ||
                (candidate.specificity == winner->specificity && candidate.rank < winner->rank) ||
                (candidate.specificity == winner->specificity && candidate.rank == winner->rank &&
                 candidate.stable_id < winner->stable_id))
                winner = std::move(candidate);
        };
        for (const auto& offer : verb.offers) {
            const auto specificity = matching_specificity(offer.selectors);
            if (!specificity)
                continue;
            consider(Candidate{offer.slot_id, offer.condition ? &*offer.condition : nullptr,
                               offer.rank, offer.primary, *specificity,
                               std::string("verb:") + offer.id.text()});
        }
        for (const auto& interaction : m_project.interactions()) {
            for (const auto& rule : interaction.rules) {
                if (rule.verb != verb.identity.id || !rule.offer)
                    continue;
                const auto slot =
                    std::find_if(rule.slots.begin(), rule.slots.end(), [&](const auto& value) {
                        return value.slot_id == rule.offer->slot_id;
                    });
                if (slot == rule.slots.end())
                    continue;
                const auto specificity = matching_specificity(slot->selectors);
                if (!specificity)
                    continue;
                consider(Candidate{
                    rule.offer->slot_id, rule.offer->condition ? &*rule.offer->condition : nullptr,
                    rule.offer->rank, rule.offer->primary, *specificity,
                    std::string("rule:") + interaction.identity.id.text() + ":" + rule.id.text()});
            }
        }
        if (!winner)
            continue;
        if (winner->condition) {
            const std::array<core::InteractionSubjectBinding, 1> offer_bindings{{
                core::InteractionSubjectBinding{winner->slot, subject},
            }};
            auto condition =
                evaluate(*winner->condition,
                         core::ConditionEvaluationContext{.interaction_bindings = offer_bindings,
                                                          .command_results = {}});
            const auto* condition_value = condition.value_if();
            if (condition_value == nullptr)
                return core::Result<std::vector<core::VerbOfferView>,
                                    RuntimeExecutionError>::failure(condition.error());
            if (!*condition_value)
                continue;
        }
        auto label = resolve(verb.action_text.source, runtime_locale);
        const auto* text = label.value_if();
        if (text == nullptr)
            return core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>::failure(
                label.error());
        resolved.push_back(core::VerbOfferView{verb.identity.id, winner->slot, *text,
                                               verb.binding_order, winner->rank, winner->primary});
    }
    std::ranges::sort(resolved, [](const auto& left, const auto& right) {
        if (left.rank != right.rank)
            return left.rank < right.rank;
        return left.verb.text() < right.verb.text();
    });
    return core::Result<std::vector<core::VerbOfferView>, RuntimeExecutionError>::success(
        std::move(resolved));
}

std::vector<core::InteractionProgramRef>
RuntimeExecutor::resident_interaction_programs(std::span<const core::VerbId> enabled_verbs) const
{
    if (!m_room_presentation || m_room_presentation_dirty || !m_state.flow_stack().empty())
        return {};

    // Resident prediction is a conservative structural plausibility pass over the already-resolved
    // Current Room. `enabled_verbs` comes from normal RuntimeUI publication, so do not re-evaluate
    // availability or Interaction Guards here: in particular, prediction must not invoke Lua merely
    // to decide whether speculative work is worth warming.
    const auto enabled = [&](const core::VerbId& verb) {
        return std::find(enabled_verbs.begin(), enabled_verbs.end(), verb) != enabled_verbs.end();
    };
    const auto subject_family = [](const core::compiled::InteractionSubject& value) {
        if (std::holds_alternative<core::compiled::CharacterInteractionSubject>(value))
            return core::compiled::SubjectFamily::Character;
        if (std::holds_alternative<core::compiled::InteractableInteractionSubject>(value))
            return core::compiled::SubjectFamily::Interactable;
        return core::compiled::SubjectFamily::Feature;
    };
    const auto subject_identity = [](const core::compiled::InteractionSubject& value) {
        return std::visit(
            [](const auto& typed) -> std::string {
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                    return std::string("character:") + typed.character.text();
                else if constexpr (std::is_same_v<T,
                                                  core::compiled::InteractableInteractionSubject>)
                    return std::string("interactable:") + typed.interactable.text();
                else
                    return std::visit(
                        [](const auto& feature) {
                            using F = std::decay_t<decltype(feature)>;
                            if constexpr (std::is_same_v<F, core::RoomFeatureRef>)
                                return std::string("room:") + feature.room.text() + "#" +
                                       feature.feature_id.text();
                            else
                                return std::string("interactable:") + feature.interactable.text() +
                                       "#" + feature.feature_id.text();
                        },
                        typed.feature);
            },
            value);
    };
    const auto has_trait = [&](const core::compiled::InteractionSubject& value,
                               const core::TraitId& trait) {
        const auto* traits = std::visit(
            [&](const auto& typed) -> const std::vector<core::TraitId>* {
                using T = std::decay_t<decltype(typed)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(typed.character);
                    return config ? &config->identity.traits : nullptr;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(typed.interactable);
                    return config ? &config->identity.traits : nullptr;
                } else {
                    return std::visit(
                        [&](const auto& feature) -> const std::vector<core::TraitId>* {
                            const auto* owner = m_world.resolved_configuration([&]() {
                                if constexpr (std::is_same_v<std::decay_t<decltype(feature)>,
                                                             core::RoomFeatureRef>)
                                    return feature.room;
                                else
                                    return feature.interactable;
                            }());
                            if (!owner)
                                return nullptr;
                            const auto found =
                                std::find_if(owner->features.begin(), owner->features.end(),
                                             [&](const auto& item) {
                                                 return item.identity.id == feature.feature_id;
                                             });
                            return found == owner->features.end() ? nullptr
                                                                  : &found->identity.traits;
                        },
                        typed.feature);
                }
            },
            value);
        return traits && std::find(traits->begin(), traits->end(), trait) != traits->end();
    };
    const auto selector_matches = [&](const core::compiled::SubjectSelector& selector,
                                      const core::compiled::InteractionSubject& subject) {
        return std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::AnySubjectSelector>)
                    return true;
                else if constexpr (std::is_same_v<T, core::compiled::FamilySubjectSelector>)
                    return value.family == subject_family(subject);
                else if constexpr (std::is_same_v<T, core::compiled::TraitSubjectSelector>)
                    return has_trait(subject, value.trait);
                else if constexpr (std::is_same_v<
                                       T, core::compiled::InteractableDefinitionSubjectSelector>) {
                    const auto* interactable =
                        std::get_if<core::compiled::InteractableInteractionSubject>(&subject);
                    return interactable && m_world.matches_interactable(
                                               interactable->interactable,
                                               InteractableMatcher{value.interactable_definition});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableFeatureSubjectSelector>) {
                    const auto* feature =
                        std::get_if<core::compiled::FeatureInteractionSubject>(&subject);
                    const auto* interactable =
                        feature ? std::get_if<core::InteractableFeatureRef>(&feature->feature)
                                : nullptr;
                    return interactable && interactable->feature_id == value.feature_id &&
                           m_world.matches_interactable(
                               interactable->interactable,
                               InteractableMatcher{value.interactable_definition});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::QualifiedPatternSubjectSelector>) {
                    if (value.family != subject_family(subject))
                        return false;
                    const auto identity = subject_identity(subject);
                    const auto prefix = value.pattern.substr(0, value.pattern.size() - 1);
                    return identity.starts_with(prefix);
                } else
                    return value.subject == subject;
            },
            selector);
    };
    const auto union_matches = [&](const std::vector<core::compiled::SubjectSelector>& selectors,
                                   const core::compiled::InteractionSubject& subject) {
        return std::any_of(selectors.begin(), selectors.end(), [&](const auto& selector) {
            return selector_matches(selector, subject);
        });
    };
    const auto slot_has_candidate = [&](const core::compiled::InteractionSlotSelector& slot) {
        return std::any_of(m_room_presentation->eligible_subjects.begin(),
                           m_room_presentation->eligible_subjects.end(), [&](const auto& subject) {
                               return union_matches(slot.selectors, subject);
                           });
    };
    const auto verb_slot_has_candidate = [&](const core::compiled::VerbSlot& slot) {
        return std::any_of(m_room_presentation->eligible_subjects.begin(),
                           m_room_presentation->eligible_subjects.end(), [&](const auto& subject) {
                               return union_matches(slot.selectors, subject);
                           });
    };

    std::vector<core::InteractionProgramRef> result;
    std::vector<core::VerbId> plausible_verbs;
    for (const auto& verb : m_project.verbs()) {
        if (!enabled(verb.identity.id) ||
            !std::all_of(verb.slots.begin(), verb.slots.end(), verb_slot_has_candidate))
            continue;
        plausible_verbs.push_back(verb.identity.id);
    }
    const auto plausible_verb = [&](const core::VerbId& verb) {
        return std::find(plausible_verbs.begin(), plausible_verbs.end(), verb) !=
               plausible_verbs.end();
    };

    for (const auto& interaction : m_project.interactions()) {
        for (const auto& rule : interaction.rules) {
            const auto* verb = m_project.find_verb(rule.verb);
            if (verb == nullptr || !plausible_verb(rule.verb) ||
                rule.slots.size() != verb->slots.size() ||
                !std::all_of(rule.slots.begin(), rule.slots.end(), slot_has_candidate))
                continue;
            result.emplace_back(core::InteractionRuleProgramRef{interaction.identity.id, rule.id});
        }
    }

    bool undefined_possible = false;
    for (const auto& verb : m_project.verbs()) {
        if (!plausible_verb(verb.identity.id))
            continue;
        result.emplace_back(core::VerbDefaultProgramRef{verb.identity.id});
        undefined_possible |=
            verb.default_program.outcome == core::compiled::InteractionOutcome::Unhandled;
    }
    if (undefined_possible && m_project.undefined_interaction_program())
        result.emplace_back(core::ProjectUndefinedProgramRef{});
    return result;
}

core::Result<core::CommandBuilderWatchedReferenceView, RuntimeExecutionError>
RuntimeExecutor::command_builder_reference(const core::compiled::InteractionSubject& subject,
                                           std::string_view runtime_locale)
{
    core::CommandBuilderWatchedReferenceView view{.subject = subject,
                                                  .live = false,
                                                  .available = false,
                                                  .enabled = false,
                                                  .visible = false,
                                                  .effective_room = std::nullopt,
                                                  .traits = {},
                                                  .offers = {}};
    auto offers = verb_offers(subject, runtime_locale);
    if (!offers)
        return core::Result<core::CommandBuilderWatchedReferenceView,
                            RuntimeExecutionError>::failure(offers.error());
    view.offers = std::move(*offers.value_if());
    view.available =
        m_room_presentation && std::find(m_room_presentation->eligible_subjects.begin(),
                                         m_room_presentation->eligible_subjects.end(),
                                         subject) != m_room_presentation->eligible_subjects.end();

    std::visit(
        [&](const auto& typed) {
            using T = std::decay_t<decltype(typed)>;
            if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>) {
                const auto* definition = m_world.resolved_configuration(typed.character);
                const auto* state = m_world.character_state(typed.character);
                view.live = definition != nullptr && state != nullptr;
                if (definition)
                    view.traits = definition->identity.traits;
                if (state) {
                    view.enabled = state->enabled;
                    view.visible = state->visible;
                    view.effective_room = m_world.effective_room(typed.character);
                }
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::InteractableInteractionSubject>) {
                const auto* definition = m_world.resolved_configuration(typed.interactable);
                const auto* state = m_world.interactable_state(typed.interactable);
                view.live = definition != nullptr && state != nullptr;
                if (definition)
                    view.traits = definition->identity.traits;
                if (state) {
                    view.enabled = state->enabled;
                    view.visible = state->visible;
                    view.effective_room = m_world.effective_room(typed.interactable);
                }
            } else {
                std::visit(
                    [&](const auto& feature) {
                        using F = std::decay_t<decltype(feature)>;
                        if constexpr (std::is_same_v<F, core::RoomFeatureRef>) {
                            const auto* owner = m_world.resolved_configuration(feature.room);
                            if (owner) {
                                const auto found =
                                    std::find_if(owner->features.begin(), owner->features.end(),
                                                 [&](const auto& item) {
                                                     return item.identity.id == feature.feature_id;
                                                 });
                                if (found != owner->features.end()) {
                                    view.live = true;
                                    view.enabled = true;
                                    view.visible = true;
                                    view.effective_room = feature.room;
                                    view.traits = found->identity.traits;
                                }
                            }
                        } else {
                            const auto* owner =
                                m_world.resolved_configuration(feature.interactable);
                            const auto* state = m_world.interactable_state(feature.interactable);
                            if (owner) {
                                const auto found =
                                    std::find_if(owner->features.begin(), owner->features.end(),
                                                 [&](const auto& item) {
                                                     return item.identity.id == feature.feature_id;
                                                 });
                                if (found != owner->features.end()) {
                                    view.live = state != nullptr;
                                    view.traits = found->identity.traits;
                                    if (state) {
                                        view.enabled = state->enabled;
                                        view.visible = state->visible;
                                        view.effective_room =
                                            m_world.effective_room(feature.interactable);
                                    }
                                }
                            }
                        }
                    },
                    typed.feature);
            }
        },
        subject);
    return core::Result<core::CommandBuilderWatchedReferenceView, RuntimeExecutionError>::success(
        std::move(view));
}

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::interact(core::VerbId verb_id,
                          std::vector<core::InteractionSubjectBinding> bindings)
{
    return interact_in_context(std::move(verb_id), std::move(bindings), std::nullopt);
}

core::Result<void, RuntimeExecutionError>
RuntimeExecutor::interact_in_context(core::VerbId verb_id,
                                     std::vector<core::InteractionSubjectBinding> bindings,
                                     std::optional<core::SceneFramePosition> scene_next_position)
{
    const auto* room_mode = std::get_if<core::RoomMode>(&m_state.mode());
    const auto* verb = m_project.find_verb(verb_id);
    const auto* scene_frame = scene_next_position && !m_state.flow_stack().empty()
                                  ? std::get_if<core::SceneFrame>(&m_state.flow_stack().back())
                                  : nullptr;
    const std::optional<core::RoomId> active_room =
        room_mode != nullptr ? std::optional<core::RoomId>{room_mode->room}
        : scene_frame != nullptr && m_state.room_visit()
            ? std::optional<core::RoomId>{m_state.room_visit()->room}
            : std::nullopt;
    if (!active_room || verb == nullptr ||
        (!scene_next_position && !m_state.flow_stack().empty()) ||
        (scene_next_position && scene_frame == nullptr))
        return core::Result<void, RuntimeExecutionError>::failure(
            interaction_error("execution.invalid_interaction_invocation",
                              "Interaction requires a Current Room and a valid Verb"));

    if (!m_room_presentation || m_room_presentation_dirty ||
        m_room_presentation->presentation.visit.room != *active_room) {
        auto settled = refresh_room_presentation({});
        if (!settled)
            return core::Result<void, RuntimeExecutionError>::failure(settled.error());
    }

    auto subject_family = [](const core::compiled::InteractionSubject& subject) {
        if (std::holds_alternative<core::compiled::CharacterInteractionSubject>(subject))
            return core::compiled::SubjectFamily::Character;
        if (std::holds_alternative<core::compiled::InteractableInteractionSubject>(subject))
            return core::compiled::SubjectFamily::Interactable;
        return core::compiled::SubjectFamily::Feature;
    };
    auto subject_identity = [](const core::compiled::InteractionSubject& subject) {
        return std::visit(
            [](const auto& value) -> std::string {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>)
                    return std::string("character:") + value.character.text();
                else if constexpr (std::is_same_v<T,
                                                  core::compiled::InteractableInteractionSubject>)
                    return std::string("interactable:") + value.interactable.text();
                else
                    return std::visit(
                        [](const auto& feature) {
                            using F = std::decay_t<decltype(feature)>;
                            if constexpr (std::is_same_v<F, core::RoomFeatureRef>)
                                return std::string("room:") + feature.room.text() + "#" +
                                       feature.feature_id.text();
                            else
                                return std::string("interactable:") + feature.interactable.text() +
                                       "#" + feature.feature_id.text();
                        },
                        value.feature);
            },
            subject);
    };
    auto has_trait = [this](const core::compiled::InteractionSubject& subject,
                            const core::TraitId& trait) {
        const auto* traits = std::visit(
            [this](const auto& value) -> const std::vector<core::TraitId>* {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(value.character);
                    return config ? &config->identity.traits : nullptr;
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableInteractionSubject>) {
                    const auto* config = m_world.resolved_configuration(value.interactable);
                    return config ? &config->identity.traits : nullptr;
                } else {
                    return std::visit(
                        [this](const auto& feature) -> const std::vector<core::TraitId>* {
                            const auto* owner = m_world.resolved_configuration([&]() {
                                if constexpr (std::is_same_v<std::decay_t<decltype(feature)>,
                                                             core::RoomFeatureRef>)
                                    return feature.room;
                                else
                                    return feature.interactable;
                            }());
                            if (!owner)
                                return nullptr;
                            const auto found =
                                std::find_if(owner->features.begin(), owner->features.end(),
                                             [&](const auto& item) {
                                                 return item.identity.id == feature.feature_id;
                                             });
                            return found == owner->features.end() ? nullptr
                                                                  : &found->identity.traits;
                        },
                        value.feature);
                }
            },
            subject);
        return traits && std::find(traits->begin(), traits->end(), trait) != traits->end();
    };
    auto selector_matches = [&](const core::compiled::SubjectSelector& selector,
                                const core::compiled::InteractionSubject& subject) {
        return std::visit(
            [&](const auto& value) {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::AnySubjectSelector>)
                    return true;
                else if constexpr (std::is_same_v<T, core::compiled::FamilySubjectSelector>)
                    return value.family == subject_family(subject);
                else if constexpr (std::is_same_v<T, core::compiled::TraitSubjectSelector>)
                    return has_trait(subject, value.trait);
                else if constexpr (std::is_same_v<
                                       T, core::compiled::InteractableDefinitionSubjectSelector>) {
                    const auto* interactable =
                        std::get_if<core::compiled::InteractableInteractionSubject>(&subject);
                    return interactable && m_world.matches_interactable(
                                               interactable->interactable,
                                               InteractableMatcher{value.interactable_definition});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::InteractableFeatureSubjectSelector>) {
                    const auto* feature =
                        std::get_if<core::compiled::FeatureInteractionSubject>(&subject);
                    const auto* interactable =
                        feature ? std::get_if<core::InteractableFeatureRef>(&feature->feature)
                                : nullptr;
                    return interactable && interactable->feature_id == value.feature_id &&
                           m_world.matches_interactable(
                               interactable->interactable,
                               InteractableMatcher{value.interactable_definition});
                } else if constexpr (std::is_same_v<
                                         T, core::compiled::QualifiedPatternSubjectSelector>) {
                    if (value.family != subject_family(subject))
                        return false;
                    const auto identity = subject_identity(subject);
                    const auto prefix = value.pattern.substr(0, value.pattern.size() - 1);
                    return identity.starts_with(prefix);
                } else
                    return value.subject == subject;
            },
            selector);
    };
    auto selector_union_matches = [&](const std::vector<core::compiled::SubjectSelector>& selectors,
                                      const core::compiled::InteractionSubject& subject) {
        return std::any_of(selectors.begin(), selectors.end(), [&](const auto& selector) {
            return selector_matches(selector, subject);
        });
    };

    if (bindings.size() != verb->slots.size())
        return core::Result<void, RuntimeExecutionError>::failure(
            interaction_error("execution.invalid_interaction_bindings",
                              "Interaction must bind every named Verb slot exactly once"));
    std::vector<core::VerbSlotId> seen_slots;
    for (const auto& binding : bindings) {
        const auto slot =
            std::find_if(verb->slots.begin(), verb->slots.end(),
                         [&](const auto& item) { return item.id == binding.slot_id; });
        if (slot == verb->slots.end() ||
            std::find(seen_slots.begin(), seen_slots.end(), binding.slot_id) != seen_slots.end() ||
            !selector_union_matches(slot->selectors, binding.subject))
            return core::Result<void, RuntimeExecutionError>::failure(
                interaction_error("execution.invalid_interaction_bindings",
                                  "Interaction binding does not satisfy the named Verb slot"));
        seen_slots.push_back(binding.slot_id);
        if (std::find(m_room_presentation->eligible_subjects.begin(),
                      m_room_presentation->eligible_subjects.end(),
                      binding.subject) == m_room_presentation->eligible_subjects.end())
            return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                "execution.interaction_subject_unavailable",
                "Interaction subject is not eligible in the active Room resolution"));
    }

    auto available = evaluate(verb->availability);
    const auto* availability_value = available.value_if();
    if (availability_value == nullptr)
        return core::Result<void, RuntimeExecutionError>::failure(available.error());
    if (!*availability_value)
        return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
            "execution.verb_unavailable", "Verb availability rejected the interaction"));

    auto selector_contained_by = [&](const core::compiled::SubjectSelector& narrow,
                                     const core::compiled::SubjectSelector& broad) {
        if (std::holds_alternative<core::compiled::AnySubjectSelector>(broad))
            return true;
        if (narrow.index() == broad.index()) {
            if (std::holds_alternative<core::compiled::AnySubjectSelector>(narrow))
                return true;
            if (const auto* left = std::get_if<core::compiled::FamilySubjectSelector>(&narrow))
                return left->family ==
                       std::get<core::compiled::FamilySubjectSelector>(broad).family;
            if (const auto* left = std::get_if<core::compiled::TraitSubjectSelector>(&narrow))
                return left->trait == std::get<core::compiled::TraitSubjectSelector>(broad).trait;
            if (const auto* left =
                    std::get_if<core::compiled::InteractableDefinitionSubjectSelector>(&narrow))
                return left->interactable_definition ==
                       std::get<core::compiled::InteractableDefinitionSubjectSelector>(broad)
                           .interactable_definition;
            if (const auto* left =
                    std::get_if<core::compiled::InteractableFeatureSubjectSelector>(&narrow)) {
                const auto& right =
                    std::get<core::compiled::InteractableFeatureSubjectSelector>(broad);
                return left->interactable_definition == right.interactable_definition &&
                       left->feature_id == right.feature_id;
            }
            if (const auto* left =
                    std::get_if<core::compiled::QualifiedPatternSubjectSelector>(&narrow)) {
                const auto& right =
                    std::get<core::compiled::QualifiedPatternSubjectSelector>(broad);
                const auto left_prefix = left->pattern.substr(0, left->pattern.size() - 1);
                const auto right_prefix = right.pattern.substr(0, right.pattern.size() - 1);
                return left->family == right.family && left_prefix.starts_with(right_prefix);
            }
            return std::get<core::compiled::ExactSubjectSelector>(narrow).subject ==
                   std::get<core::compiled::ExactSubjectSelector>(broad).subject;
        }
        if (const auto* family = std::get_if<core::compiled::FamilySubjectSelector>(&broad)) {
            if (const auto* exact = std::get_if<core::compiled::ExactSubjectSelector>(&narrow))
                return subject_family(exact->subject) == family->family;
            if (const auto* pattern =
                    std::get_if<core::compiled::QualifiedPatternSubjectSelector>(&narrow))
                return pattern->family == family->family;
            if (std::holds_alternative<core::compiled::InteractableDefinitionSubjectSelector>(
                    narrow))
                return family->family == core::compiled::SubjectFamily::Interactable;
            if (std::holds_alternative<core::compiled::InteractableFeatureSubjectSelector>(narrow))
                return family->family == core::compiled::SubjectFamily::Feature;
        }
        if (const auto* trait = std::get_if<core::compiled::TraitSubjectSelector>(&broad)) {
            if (const auto* exact = std::get_if<core::compiled::ExactSubjectSelector>(&narrow))
                return has_trait(exact->subject, trait->trait);
        }
        if (const auto* definition =
                std::get_if<core::compiled::InteractableDefinitionSubjectSelector>(&broad)) {
            if (const auto* exact = std::get_if<core::compiled::ExactSubjectSelector>(&narrow)) {
                const auto* interactable =
                    std::get_if<core::compiled::InteractableInteractionSubject>(&exact->subject);
                return interactable &&
                       m_world.matches_interactable(
                           interactable->interactable,
                           InteractableMatcher{definition->interactable_definition});
            }
        }
        if (const auto* definition =
                std::get_if<core::compiled::InteractableFeatureSubjectSelector>(&broad)) {
            if (const auto* exact = std::get_if<core::compiled::ExactSubjectSelector>(&narrow)) {
                const auto* feature =
                    std::get_if<core::compiled::FeatureInteractionSubject>(&exact->subject);
                const auto* interactable =
                    feature ? std::get_if<core::InteractableFeatureRef>(&feature->feature)
                            : nullptr;
                return interactable && interactable->feature_id == definition->feature_id &&
                       m_world.matches_interactable(
                           interactable->interactable,
                           InteractableMatcher{definition->interactable_definition});
            }
        }
        if (const auto* pattern =
                std::get_if<core::compiled::QualifiedPatternSubjectSelector>(&broad)) {
            if (const auto* exact = std::get_if<core::compiled::ExactSubjectSelector>(&narrow)) {
                if (subject_family(exact->subject) != pattern->family)
                    return false;
                const auto prefix = pattern->pattern.substr(0, pattern->pattern.size() - 1);
                return subject_identity(exact->subject).starts_with(prefix);
            }
        }
        return false;
    };
    auto union_contained_by = [&](const std::vector<core::compiled::SubjectSelector>& narrow,
                                  const std::vector<core::compiled::SubjectSelector>& broad) {
        return std::all_of(narrow.begin(), narrow.end(), [&](const auto& selector) {
            return std::any_of(broad.begin(), broad.end(), [&](const auto& candidate) {
                return selector_contained_by(selector, candidate);
            });
        });
    };
    auto rule_contained_by = [&](const core::compiled::InteractionRule& narrow,
                                 const core::compiled::InteractionRule& broad) {
        for (const auto& narrow_slot : narrow.slots) {
            const auto broad_slot =
                std::find_if(broad.slots.begin(), broad.slots.end(),
                             [&](const auto& slot) { return slot.slot_id == narrow_slot.slot_id; });
            if (broad_slot == broad.slots.end() ||
                !union_contained_by(narrow_slot.selectors, broad_slot->selectors))
                return false;
        }
        return true;
    };

    struct Candidate {
        core::InteractionRuleProgramRef reference;
        const core::compiled::InteractionRule* rule = nullptr;
    };
    std::vector<Candidate> remaining;
    for (const auto& interaction : m_project.interactions()) {
        for (const auto& rule : interaction.rules) {
            if (rule.verb != verb_id || rule.slots.size() != bindings.size())
                continue;
            const bool matches =
                std::all_of(rule.slots.begin(), rule.slots.end(), [&](const auto& slot) {
                    const auto binding =
                        std::find_if(bindings.begin(), bindings.end(), [&](const auto& item) {
                            return item.slot_id == slot.slot_id;
                        });
                    return binding != bindings.end() &&
                           selector_union_matches(slot.selectors, binding->subject);
                });
            if (matches)
                remaining.push_back({{interaction.identity.id, rule.id}, &rule});
        }
    }

    std::optional<core::InteractionRuleProgramRef> selected;
    while (!remaining.empty() && !selected) {
        std::vector<std::size_t> tier;
        for (std::size_t index = 0; index < remaining.size(); ++index) {
            bool has_strictly_narrower = false;
            for (std::size_t other = 0; other < remaining.size(); ++other) {
                if (index == other)
                    continue;
                const bool other_within =
                    rule_contained_by(*remaining[other].rule, *remaining[index].rule);
                const bool index_within =
                    rule_contained_by(*remaining[index].rule, *remaining[other].rule);
                if (other_within && !index_within) {
                    has_strictly_narrower = true;
                    break;
                }
            }
            if (!has_strictly_narrower)
                tier.push_back(index);
        }

        std::optional<std::int64_t> winning_priority;
        std::vector<std::size_t> passing;
        for (const auto index : tier) {
            auto guard = evaluate(remaining[index].rule->guard,
                                  core::ConditionEvaluationContext{.interaction_bindings = bindings,
                                                                   .command_results = {}});
            const auto* guard_value = guard.value_if();
            if (guard_value == nullptr)
                return core::Result<void, RuntimeExecutionError>::failure(guard.error());
            if (!*guard_value)
                continue;
            const auto priority = remaining[index].rule->priority;
            if (!winning_priority || priority > *winning_priority) {
                winning_priority = priority;
                passing = {index};
            } else if (priority == *winning_priority) {
                passing.push_back(index);
            }
        }
        if (passing.size() > 1)
            return core::Result<void, RuntimeExecutionError>::failure(interaction_error(
                "execution.ambiguous_interaction",
                "Multiple Interaction Rules passed at equal structural tier and priority"));
        if (passing.size() == 1) {
            selected = remaining[passing.front()].reference;
            break;
        }

        std::vector<Candidate> broader;
        broader.reserve(remaining.size() - tier.size());
        for (std::size_t index = 0; index < remaining.size(); ++index)
            if (std::find(tier.begin(), tier.end(), index) == tier.end())
                broader.push_back(remaining[index]);
        remaining = std::move(broader);
    }

    const core::InteractionProgramRef program =
        selected ? core::InteractionProgramRef{*selected}
                 : core::InteractionProgramRef{core::VerbDefaultProgramRef{verb_id}};
    auto started =
        scene_next_position
            ? m_flow.call_interaction(
                  core::InteractionInvocationContext{verb_id, *active_room, std::move(bindings)},
                  program, std::move(*scene_next_position))
            : m_flow.start_interaction(
                  core::InteractionInvocationContext{verb_id, *active_room, std::move(bindings)},
                  program);
    return started ? core::Result<void, RuntimeExecutionError>::success()
                   : core::Result<void, RuntimeExecutionError>::failure(started.error());
}

std::optional<core::FlowRunOutcome>
RuntimeExecutor::run_interaction_unit(std::string_view runtime_locale)
{
    auto fault = [this](core::Diagnostics diagnostics) -> core::FlowRunOutcome {
        const auto copy = diagnostics;
        (void)m_flow.fault(std::move(diagnostics));
        return core::FlowFaultOutcome{copy};
    };
    auto* frame = std::get_if<core::InteractionFrame>(&m_state.m_flow_stack.back());
    if (frame == nullptr)
        return fault(
            interaction_error("execution.invalid_interaction", "Interaction frame is missing"));
    const auto expected = frame->position;
    const auto* program = program_for(m_project, frame->program);
    if (program == nullptr)
        return fault(interaction_error("execution.invalid_interaction_program",
                                       "Interaction program is missing"));

    if (expected.awaiting_completion) {
        auto next = expected;
        next.awaiting_completion = false;
        next.next_instruction = expected.next_instruction
                                    ? next_instruction(*program, *expected.next_instruction)
                                    : std::nullopt;
        auto advanced = m_flow.advance_interaction(expected, frame->program, next);
        if (!advanced)
            return fault(advanced.error());
        return std::nullopt;
    }

    if (!expected.next_instruction) {
        const auto outcome = program->outcome == core::compiled::InteractionOutcome::Handled
                                 ? core::InteractionExecutionOutcome::Handled
                                 : core::InteractionExecutionOutcome::Unhandled;
        if (outcome == core::InteractionExecutionOutcome::Handled) {
            auto applied = m_flow.apply_target(program->completion);
            if (!applied)
                return fault(applied.error());
            return std::nullopt;
        }

        if (std::holds_alternative<core::InteractionRuleProgramRef>(frame->program)) {
            core::InteractionProgramRef next_program =
                core::VerbDefaultProgramRef{frame->invocation.verb};
            const auto* next_definition = program_for(m_project, next_program);
            if (next_definition == nullptr)
                return fault(interaction_error("execution.invalid_interaction_program",
                                               "Verb default program is missing"));
            auto next = core::InteractionFramePosition{
                first_instruction(*next_definition), core::InteractionFallbackStage::VerbDefault,
                core::InteractionExecutionOutcome::Pending, false};
            frame->command_results.clear();
            auto advanced = m_flow.advance_interaction(expected, std::move(next_program), next);
            if (!advanced)
                return fault(advanced.error());
            return std::nullopt;
        }
        if (std::holds_alternative<core::VerbDefaultProgramRef>(frame->program) &&
            m_project.undefined_interaction_program()) {
            core::InteractionProgramRef next_program = core::ProjectUndefinedProgramRef{};
            const auto* next_definition = program_for(m_project, next_program);
            auto next =
                core::InteractionFramePosition{first_instruction(*next_definition),
                                               core::InteractionFallbackStage::UndefinedInteraction,
                                               core::InteractionExecutionOutcome::Pending, false};
            frame->command_results.clear();
            auto advanced = m_flow.advance_interaction(expected, std::move(next_program), next);
            if (!advanced)
                return fault(advanced.error());
            return std::nullopt;
        }

        auto requested = m_gateway.request_notification(
            std::string(undefined_interaction_message(runtime_locale)));
        if (!requested)
            return fault(requested.error());
        auto returned = m_flow.return_from_flow();
        if (!returned)
            return fault(returned.error());
        return std::nullopt;
    }

    const auto instruction_id = *expected.next_instruction;
    const auto* instruction = find_instruction(*program, instruction_id);
    if (instruction == nullptr)
        return fault(interaction_error("execution.invalid_interaction_instruction",
                                       "Interaction instruction is missing"));

    if (gameplay_command_is_immediate(*instruction)) {
        auto staged_state = m_state;
        core::FlowExecutor staged_flow(m_project, staged_state);
        core::SharedPrimitiveEvaluator staged_primitives(m_project, staged_state, staged_flow);
        RuntimeWorld staged_world(m_project, staged_state);
        auto staged_results = frame->command_results;
        std::vector<const core::GameplayCommand*> batch;
        auto cursor = std::optional<core::InteractionInstructionId>{instruction_id};
        while (cursor) {
            const auto* candidate = find_instruction(*program, *cursor);
            if (candidate == nullptr || !gameplay_command_is_immediate(*candidate))
                break;
            batch.push_back(candidate);
            cursor = next_instruction(*program, *cursor);
        }
        for (const auto* candidate : batch) {
            auto applied = apply_immediate_gameplay_command(
                *candidate, staged_state, staged_world, staged_flow, staged_primitives,
                frame->invocation.bindings, staged_results);
            if (!applied)
                return fault(applied.error());
        }
        for (const auto* candidate : batch) {
            auto applied = apply_immediate_gameplay_command(
                *candidate, m_state, m_world, m_flow, m_primitives, frame->invocation.bindings,
                frame->command_results);
            if (!applied)
                return fault(applied.error());
        }
        auto next = expected;
        next.next_instruction = cursor;
        auto advanced = m_flow.advance_interaction(expected, frame->program, next);
        return advanced ? std::nullopt
                        : std::optional<core::FlowRunOutcome>{fault(advanced.error())};
    }

    const auto sequential = next_instruction(*program, instruction_id);
    return std::visit(
        [this, &fault, &expected, &frame, &sequential,
         runtime_locale](const auto& value) -> std::optional<core::FlowRunOutcome> {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::RunLuaCommand>) {
                auto applied = invoke_script(value.source, "gameplay-command");
                const auto* outcome = applied.value_if();
                if (outcome == nullptr)
                    return fault(interaction_error("execution.interaction_script_failed",
                                                   applied.error().message));
                auto next = expected;
                if (std::holds_alternative<ScriptInvocationSuspended>(*outcome)) {
                    next.awaiting_completion = true;
                    auto marked = m_flow.mark_interaction_wait(expected, next);
                    if (!marked)
                        return fault(marked.error());
                    return core::FlowBlockedOutcome{*m_state.blocker()};
                }
                next.next_instruction = sequential;
                auto advanced = m_flow.advance_interaction(expected, frame->program, next);
                return advanced ? std::nullopt
                                : std::optional<core::FlowRunOutcome>{fault(advanced.error())};
            } else if constexpr (std::is_same_v<T, core::NotifyCommand>) {
                auto message = resolve(value.message.source, runtime_locale);
                const auto* text = message.value_if();
                if (text == nullptr) {
                    if (const auto* script = std::get_if<ScriptInvocationError>(&message.error()))
                        return fault(interaction_error("execution.interaction_text_failed",
                                                       script->message));
                    return fault(std::get<core::Diagnostics>(message.error()));
                }
                auto requested = m_gateway.request_notification(*text);
                if (!requested)
                    return fault(requested.error());
            } else if constexpr (std::is_same_v<T, core::PresentInventoryCommand>) {
                const core::ConditionEvaluationContext context{
                    .interaction_bindings = frame->invocation.bindings,
                    .command_results = frame->command_results};
                auto inventory = m_primitives.resolve_inventory(value.inventory, context);
                if (!inventory)
                    return fault(inventory.error());
                auto presented = present_inventory(
                    *inventory.value_if(), value.layout,
                    value.use_trigger_anchor ? m_trigger_context : std::nullopt,
                    value.parent_to_triggering_layout ? m_trigger_presentation_parent
                                                      : std::nullopt,
                    value.coexist, value.use_trigger_anchor);
                if (!presented)
                    return fault(presented.error());
            } else if constexpr (std::is_same_v<T, core::NavigateExitCommand>) {
                auto next = expected;
                next.next_instruction = sequential;
                auto called = call_navigation_command(value, core::FlowFramePosition{next});
                return called ? std::nullopt
                              : std::optional<core::FlowRunOutcome>{fault(called.error())};
            } else if constexpr (std::is_same_v<T, core::ChangeRoomCommand>) {
                const core::ConditionEvaluationContext context{
                    .interaction_bindings = frame->invocation.bindings,
                    .command_results = frame->command_results};
                auto next = expected;
                next.next_instruction = sequential;
                auto called =
                    call_change_room_command(value, context, core::FlowFramePosition{next});
                return called ? std::nullopt
                              : std::optional<core::FlowRunOutcome>{fault(called.error())};
            } else if constexpr (std::is_same_v<T, core::CallSceneCommand>) {
                auto next = expected;
                next.next_instruction = sequential;
                auto called = m_flow.call_child(value.scene, core::FlowFramePosition{next});
                return called ? std::nullopt
                              : std::optional<core::FlowRunOutcome>{fault(called.error())};
            } else if constexpr (std::is_same_v<T, core::CallDialogueCommand>) {
                auto next = expected;
                next.next_instruction = sequential;
                auto called =
                    m_flow.call_child(value.dialogue, std::nullopt, core::FlowFramePosition{next});
                return called ? std::nullopt
                              : std::optional<core::FlowRunOutcome>{fault(called.error())};
            } else if constexpr (std::is_same_v<T, core::IfGameplayCommand>) {
                const core::ConditionEvaluationContext context{
                    .interaction_bindings = frame->invocation.bindings,
                    .command_results = frame->command_results};
                auto condition = m_primitives.evaluate(value.condition, context);
                if (!condition)
                    return fault(condition.error());
                const auto& branch =
                    *condition.value_if() ? value.then_commands : value.else_commands;
                auto next = expected;
                next.next_instruction =
                    branch.empty()
                        ? sequential
                        : std::optional<core::InteractionInstructionId>{branch.front().id};
                auto advanced = m_flow.advance_interaction(expected, frame->program, next);
                return advanced ? std::nullopt
                                : std::optional<core::FlowRunOutcome>{fault(advanced.error())};
            } else {
                return fault(interaction_error(
                    "execution.invalid_interaction_program",
                    "Immediate Gameplay Command reached an observable command boundary"));
            }
            auto next = expected;
            next.next_instruction = sequential;
            auto advanced = m_flow.advance_interaction(expected, frame->program, next);
            return advanced ? std::nullopt
                            : std::optional<core::FlowRunOutcome>{fault(advanced.error())};
        },
        instruction->value);
}

core::Result<core::InteractionView, RuntimeExecutionError>
RuntimeExecutor::interaction_view(std::string_view)
{
    const auto* frame = m_state.flow_stack().empty()
                            ? nullptr
                            : std::get_if<core::InteractionFrame>(&m_state.flow_stack().back());
    if (frame == nullptr)
        return core::Result<core::InteractionView, RuntimeExecutionError>::failure(
            interaction_error("execution.no_interaction_view", "No Interaction is active"));
    core::InteractionView view{frame->invocation.verb, frame->invocation.room,
                               frame->invocation.bindings, frame->program, std::nullopt};
    for (auto it = m_gateway.events().rbegin(); it != m_gateway.events().rend(); ++it) {
        const auto* notification = std::get_if<runtime::NotificationEvent>(&*it);
        if (notification != nullptr) {
            view.notification = notification->message;
            break;
        }
    }
    return core::Result<core::InteractionView, RuntimeExecutionError>::success(std::move(view));
}

core::Result<core::InventoryView, RuntimeExecutionError>
RuntimeExecutor::inventory_view(std::string_view runtime_locale)
{
    core::InventoryView view;
    const auto owner_room = [&](const core::compiled::InventoryOwnerRef& owner) {
        return std::visit(
            [&](const auto& value) -> std::optional<core::RoomId> {
                using T = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<T, core::compiled::CharacterInventoryOwner>)
                    return m_world.effective_room(value.character);
                else if constexpr (std::is_same_v<T, core::compiled::InteractableInventoryOwner>)
                    return m_world.effective_room(value.interactable);
                else if constexpr (std::is_same_v<T, core::RoomFeatureRef>)
                    return value.room;
                else if constexpr (std::is_same_v<T, core::InteractableFeatureRef>)
                    return m_world.effective_room(value.interactable);
                else
                    return std::nullopt;
            },
            owner);
    };
    const auto append_inventories =
        [&](const core::compiled::InventoryOwnerRef& owner,
            const std::vector<core::compiled::InventoryDefinition>& values) {
            for (const auto& inventory : values) {
                core::compiled::InventoryRef reference{owner, inventory.id};
                view.inventories.push_back(
                    {reference, inventory.label, owner_room(reference.owner)});
            }
        };
    append_inventories(core::compiled::ProjectInventoryOwner{}, m_project.inventories());
    if (m_project.settings().inventory.player_inventory) {
        const core::compiled::InventoryRef player_inventory{
            core::compiled::ProjectInventoryOwner{},
            *m_project.settings().inventory.player_inventory,
        };
        view.player_inventory = player_inventory;
        view.player_inventory_available = m_world.has_inventory(player_inventory);
    }
    for (const auto& record : m_state.runtime_characters()) {
        const auto& character = record.effective_configuration();
        append_inventories(core::compiled::CharacterInventoryOwner{record.id},
                           character.inventories);
    }
    for (const auto& record : m_state.runtime_rooms()) {
        const auto& room = record.effective_configuration();
        for (const auto& feature : room.features)
            append_inventories(core::RoomFeatureRef{record.id, feature.identity.id},
                               feature.inventories);
    }
    for (const auto& record : m_state.runtime_interactables()) {
        const auto& interactable = record.effective_configuration();
        append_inventories(core::compiled::InteractableInventoryOwner{record.id},
                           interactable.inventories);
        for (const auto& feature : interactable.features)
            append_inventories(core::InteractableFeatureRef{record.id, feature.identity.id},
                               feature.inventories);
    }
    for (const auto& state : m_state.interactables()) {
        const auto* location = std::get_if<core::compiled::InventoryLocation>(&state.location);
        if (location == nullptr)
            continue;
        const auto* definition = m_world.resolved_configuration(state.interactable);
        if (definition == nullptr || !m_world.has_inventory(location->inventory))
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(
                interaction_error("execution.invalid_inventory",
                                  "Inventory definition or membership reference is missing"));
        view.items.push_back({state.interactable, definition->identity.id, location->inventory,
                              m_world.effective_room(state.interactable), definition->display_name,
                              definition->presentation, state.quantity, definition->stackable,
                              definition->stack_limit, definition->identity.traits, state.enabled,
                              state.visible});
    }
    std::ranges::sort(view.items, {}, [](const auto& item) { return item.interactable.text(); });
    std::uint64_t latest_inventory_occurrence = 0;
    for (const auto& mounted : m_state.mounted_layouts()) {
        if (mounted.policy.visibility != core::LayoutVisibility::Visible || !mounted.occurrence)
            continue;
        const auto context =
            std::find_if(mounted.inputs.begin(), mounted.inputs.end(), [](const auto& input) {
                return input.input.text() == core::inventory_layout_context_input;
            });
        if (context == mounted.inputs.end() ||
            mounted.occurrence->number() < latest_inventory_occurrence)
            continue;
        const auto* literal = std::get_if<core::LayoutLiteralInput>(&context->source);
        const auto* key = literal ? std::get_if<std::string>(&literal->value) : nullptr;
        if (!key)
            continue;
        latest_inventory_occurrence = mounted.occurrence->number();
        view.presented_inventory_key = *key;
    }
    for (const auto& verb : m_project.verbs()) {
        auto label = resolve(verb.action_text.source, runtime_locale);
        const auto* text = label.value_if();
        if (text == nullptr)
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(label.error());
        auto available = evaluate(verb.availability);
        const auto* enabled = available.value_if();
        if (enabled == nullptr)
            return core::Result<core::InventoryView, RuntimeExecutionError>::failure(
                available.error());
        view.controls.push_back({verb.identity.id, *text, verb.binding_order, *enabled});
    }
    return core::Result<core::InventoryView, RuntimeExecutionError>::success(std::move(view));
}

} // namespace noveltea::runtime
