#include "ui/rmlui/active_text_presenter.hpp"

#include "noveltea/assets/asset_manager.hpp"
#include "text/text_breaks.hpp"
#include "ui/rmlui/rmlui_custom_components.hpp"

#include <algorithm>
#include <utility>
#include <variant>

namespace noveltea::ui::rmlui {
namespace {

constexpr float kActiveTextBaseSize = 17.0f;

core::RichTextDocument active_text_document(const core::TypedRuntimeUIViewState& state)
{
    return make_active_text_snapshot(state).rich_text;
}

std::string active_text_content_key(const core::TypedRuntimeUIViewState& state)
{
    const auto document = active_text_document(state);
    return state.mode + ":" + document.plain_text;
}

ActiveTextPlaybackInput playback_input(const core::TypedRuntimeUIViewState& state,
                                       std::size_t page_index, float delta_seconds)
{
    const auto document = active_text_document(state);
    const auto page = active_text_document_page(document, page_index);
    return ActiveTextPlaybackInput{
        .body_key = state.mode + ":" + document.plain_text + ":page:" + std::to_string(page_index),
        .glyph_count = text::utf8_grapheme_count(page.plain_text),
        .delta_seconds = delta_seconds,
        .awaiting_continue = state.can_continue,
        .page_break = page_index + 1u < active_text_page_count(document)};
}

std::uint64_t utf8_codepoint_count(std::string_view value) noexcept
{
    std::uint64_t count = 0;
    for (const unsigned char byte : value)
        if ((byte & 0xc0u) != 0x80u)
            ++count;
    return count;
}

std::optional<core::RuntimeInputMessage>
dialogue_reveal_input(const core::TypedRuntimeUIViewState* view, std::size_t page_index,
                      float reveal_progress, bool skipping)
{
    if (view == nullptr || !view->dialogue || !view->dialogue->line || !view->dialogue->segment)
        return std::nullopt;
    const auto document = active_text_document(*view);
    const auto page_count = active_text_page_count(document);
    page_index = std::min(page_index, page_count - 1u);
    std::uint64_t offset = 0;
    for (std::size_t page = 0; page < page_index; ++page)
        offset += utf8_codepoint_count(active_text_document_page(document, page).plain_text);
    ActiveTextLayoutOptions options;
    options.page_index = page_index;
    options.reveal_progress = reveal_progress;
    offset += utf8_codepoint_count(active_text_visible_text(document, options));
    if (offset <= view->dialogue->reveal_offset)
        return std::nullopt;
    return core::RuntimeInputMessage{
        core::AdvanceDialogueRevealInput{view->dialogue->frame, view->dialogue->dialogue,
                                         *view->dialogue->segment, offset, skipping}};
}

bool interactable_available(const core::TypedRuntimeUIViewState& view,
                            const core::InteractableId& interactable)
{
    const bool available_in_room =
        view.room &&
        std::any_of(
            view.room->placements.begin(), view.room->placements.end(), [&](const auto& placement) {
                return std::any_of(
                    placement.occupants.begin(), placement.occupants.end(),
                    [&](const auto& occupant) {
                        const auto* subject =
                            std::get_if<core::compiled::InteractableInteractionSubject>(
                                &occupant.subject);
                        return subject != nullptr && subject->interactable == interactable &&
                               occupant.visible && occupant.enabled;
                    });
            });
    const bool available_in_inventory = std::any_of(
        view.inventory.items.begin(), view.inventory.items.end(), [&](const auto& item) {
            return item.interactable == interactable && item.visible && item.enabled;
        });
    return available_in_room || available_in_inventory;
}

} // namespace

ActiveTextPresenter::ActiveTextPresenter(core::Diagnostics& diagnostics)
    : m_diagnostics(diagnostics)
{
}

ActiveTextPresenter::~ActiveTextPresenter() = default;

void ActiveTextPresenter::initialize(assets::AssetManager& assets,
                                     ActiveTextPresenterShaper shape_text)
{
    m_assets = &assets;
    m_shape_text = std::move(shape_text);
    ensure_font_requests_current({});
}

void ActiveTextPresenter::ensure_font_requests_current(const core::RichTextDocument& document)
{
    if (m_assets == nullptr)
        return;

    const std::uint64_t current_generation = m_assets->source_generation_on_owner().value;
    if (m_font_generation.value != current_generation) {
        m_fonts.clear();
        m_font_generation.value = current_generation;
    }

    std::vector<std::string> aliases;
    aliases.push_back(m_assets->default_font_alias());
    for (const auto& run : document.runs) {
        if (!run.style.font_alias.empty())
            aliases.push_back(run.style.font_alias);
    }
    std::sort(aliases.begin(), aliases.end());
    aliases.erase(std::unique(aliases.begin(), aliases.end()), aliases.end());

    for (const auto& alias : aliases) {
        const auto existing =
            std::find_if(m_fonts.begin(), m_fonts.end(),
                         [&](const auto& binding) { return binding.alias == alias; });
        if (existing != m_fonts.end())
            continue;

        FontBinding binding;
        binding.alias = alias;
        auto requested = m_assets->request_font(
            assets::FontAssetRequest{
                .alias = alias, .source_path = std::nullopt, .style = TextFontRegular},
            assets::AssetRequestReason::Demand);
        if (requested)
            binding.request = std::move(*requested.value_if());
        else {
            m_diagnostics.push_back(std::move(requested).error());
            binding.failed = true;
        }
        m_fonts.push_back(std::move(binding));
    }
}

bool ActiveTextPresenter::poll_font_requests()
{
    bool pending = false;
    for (auto& binding : m_fonts) {
        if (binding.lease) {
            binding.lease->mark_used_on_owner();
            continue;
        }
        if (!binding.request)
            continue;
        if (binding.request->state() == assets::AssetRequestState::Ready) {
            binding.lease = std::move(*binding.request).take_ready();
            binding.request.reset();
            if (binding.lease)
                binding.lease->mark_used_on_owner();
            continue;
        }
        if (binding.request->state() == assets::AssetRequestState::Pending) {
            pending = true;
            continue;
        }
        core::append_diagnostics(m_diagnostics, binding.request->diagnostics());
        binding.request.reset();
        binding.failed = true;
    }
    return !pending;
}

std::optional<core::RuntimeInputMessage>
ActiveTextPresenter::advance(const core::TypedRuntimeUIViewState* view, float delta_seconds)
{
    const std::string content_key = view ? active_text_content_key(*view) : std::string{};
    if (!content_key.empty() && content_key != m_content_key)
        m_page_index = 0;
    m_content_key = content_key;

    const auto previous_instance = m_playback.instance_id;
    ActiveTextPlaybackInput input;
    if (view)
        input = playback_input(*view, m_page_index, delta_seconds);
    else
        input.delta_seconds = delta_seconds;
    m_playback = update_active_text_playback(m_playback, input, m_playback_config);
    if (m_playback.instance_id != previous_instance) {
        m_time_seconds = 0.0;
    } else if (delta_seconds > 0.0f) {
        m_time_seconds += static_cast<double>(delta_seconds);
    }
    return dialogue_reveal_input(view, m_page_index, m_playback.reveal_progress, false);
}

void ActiveTextPresenter::refresh_layout(const core::TypedRuntimeUIViewState* view,
                                         const std::optional<ActiveTextPresenterSurface>& surface)
{
    if (!surface) {
        m_layout = {};
        return;
    }

    const auto document = view ? active_text_document(*view) : core::RichTextDocument{};
    ensure_font_requests_current(document);
    m_page_count = active_text_page_count(document);
    m_page_index = std::min(m_page_index, m_page_count - 1u);

    ActiveTextLayoutOptions options;
    options.bounds = surface->bounds;
    options.default_font_alias =
        m_assets ? m_assets->default_font_alias() : std::string(kSystemFontAlias);
    options.default_text_size = kActiveTextBaseSize * surface->text_scale_factor;
    options.language = surface->language;
    options.default_color = surface->text_color;
    options.line_spacing = 1.35f;
    options.reveal_progress = m_playback.reveal_progress;
    options.alpha = m_playback.alpha;
    options.page_index = m_page_index;
    options.time_seconds = m_time_seconds;

    if (m_shape_text && poll_font_requests()) {
        m_layout = build_active_text_layout(
            document, options,
            [this, raster_scale = surface->font_raster_scale](const StyledText& text) {
                return m_shape_text(text, raster_scale);
            });
    } else {
        m_layout = build_active_text_layout(document, options);
    }
    m_layout.awaiting_continue = (view && view->can_continue) || m_layout.awaiting_continue;
    m_page_count = m_layout.page_count;
    m_page_index = m_layout.page_index;
    m_layout.prompt.visible = m_playback.prompt_visible;
    m_layout.prompt.alpha = m_playback.prompt_alpha * m_playback.alpha;
    m_layout.prompt.page_break = m_playback.page_break;
    if (m_layout.prompt.visible) {
        constexpr float prompt_size = 10.0f;
        m_layout.prompt.bounds = {
            options.bounds.x + std::max(options.bounds.width - prompt_size, 0.0f),
            options.bounds.y + std::max(options.bounds.height - prompt_size, 0.0f), prompt_size,
            prompt_size};
    }
}

bool ActiveTextPresenter::has_font_lease() const noexcept
{
    if (m_assets == nullptr)
        return false;
    const auto& default_alias = m_assets->default_font_alias();
    const auto found = std::find_if(m_fonts.begin(), m_fonts.end(), [&](const auto& binding) {
        return binding.alias == default_alias;
    });
    return found != m_fonts.end() && found->lease.has_value();
}

ActiveTextPresenterActivation
ActiveTextPresenter::activate(const core::TypedRuntimeUIViewState* view, float x, float y)
{
    ActiveTextPresenterActivation activation;
    activation.consumed = true;
    if (const auto object_id = m_layout.object_at({x, y})) {
        auto interactable = core::InteractableId::create(*object_id);
        if (!interactable) {
            core::append_diagnostics(m_diagnostics, std::move(interactable).error());
            return activation;
        }
        if (!view || !interactable_available(*view, *interactable.value_if())) {
            m_diagnostics.push_back(core::Diagnostic{
                .code = "runtime_ui.invalid_active_text_interactable",
                .message = "ActiveText interactable is stale, unknown, hidden, or disabled"});
            return activation;
        }
        activation.input = core::RuntimeInputMessage{core::SelectInteractionSubjectsInput{
            {core::compiled::InteractableInteractionSubject{*interactable.value_if()}}}};
        return activation;
    }

    if (m_playback.can_skip_reveal) {
        m_playback = skip_active_text_reveal(m_playback);
        activation.local_state_changed = true;
        activation.input =
            dialogue_reveal_input(view, m_page_index, m_playback.reveal_progress, true);
        return activation;
    }
    if (m_playback.can_continue) {
        if (m_page_index + 1u < m_page_count) {
            ++m_page_index;
            m_playback = {};
            m_time_seconds = 0.0;
            activation.local_state_changed = true;
        } else {
            activation.input = core::RuntimeInputMessage{core::ContinueInput{}};
        }
        return activation;
    }
    if (view && view->can_continue)
        activation.input = core::RuntimeInputMessage{core::ContinueInput{}};
    return activation;
}

core::ActiveTextPresentationPhase ActiveTextPresenter::presentation_phase() const noexcept
{
    if (m_playback.phase == ActiveTextPlaybackPhase::Appearing ||
        m_playback.phase == ActiveTextPlaybackPhase::Revealing) {
        return core::ActiveTextPresentationPhase::Reveal;
    }
    if (m_playback.phase == ActiveTextPlaybackPhase::Disappearing)
        return core::ActiveTextPresentationPhase::Fade;
    return core::ActiveTextPresentationPhase::Stable;
}

} // namespace noveltea::ui::rmlui
