#include <noveltea/text/text_asset_loader.hpp>

#include "assets/asset_preparation_io.hpp"
#include "text/text_engine.hpp"

#include <noveltea/assets/asset_manager.hpp>
#include <noveltea/assets/asset_source.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <memory>
#include <utility>

namespace noveltea::text {
namespace {

template<class T> assets::AssetLoadResult<T> fail(std::string error)
{
    return {std::nullopt, std::move(error)};
}

FontFamilyDesc to_font_family_desc(const assets::FontFamilyAssetDesc& desc)
{
    FontFamilyDesc family;
    family.alias = desc.alias;
    family.regular = desc.regular;
    family.bold = desc.bold;
    family.italic = desc.italic;
    family.bold_italic = desc.bold_italic;
    family.synthetic_styles = desc.synthetic_styles;
    return family;
}

[[nodiscard]] std::uint64_t saturating_add(std::uint64_t lhs, std::uint64_t rhs) noexcept
{
    return rhs > std::numeric_limits<std::uint64_t>::max() - lhs
               ? std::numeric_limits<std::uint64_t>::max()
               : lhs + rhs;
}

template<class T>
[[nodiscard]] core::Result<assets::PreparedAsset<T>, core::Diagnostics>
preparation_failure(std::string code, std::string message)
{
    return core::Result<assets::PreparedAsset<T>, core::Diagnostics>::failure(
        {{.code = std::move(code), .message = std::move(message)}});
}

} // namespace

struct FontSourceResidencyState {
    TextEngine* engine = nullptr;
};

std::uint64_t PreparedFontSource::total_source_bytes() const noexcept
{
    std::uint64_t total = regular.size();
    const auto add = [&total](const auto& value) {
        if (value)
            total = saturating_add(total, value->size());
    };
    add(bold);
    add(italic);
    add(bold_italic);
    return total;
}

struct FontSourcePreparationTask::Impl {
    enum class FaceKind : std::uint8_t {
        Regular,
        Bold,
        Italic,
        BoldItalic,
    };

    struct FaceRead {
        FaceKind kind = FaceKind::Regular;
        bool required = false;
        std::unique_ptr<assets::detail::IncrementalAssetRead> read;
    };

    Impl(const assets::AssetManager& assets, FontSourcePreparationOwner& configured_owner,
         assets::FontAssetRequest configured_request, FontFamilyDesc configured_family)
        : owner(configured_owner), request(std::move(configured_request))
    {
        prepared.family = std::move(configured_family);
        const auto append = [&](FaceKind kind, const std::optional<FontDesc>& desc, bool required) {
            if (!desc || desc->asset_path.empty())
                return;
            const std::string path = desc->asset_path.generic_string();
            const auto size = assets::detail::estimated_source_size(assets, path);
            estimate.source_bytes = saturating_add(estimate.source_bytes, size);
            estimate.temporary_bytes = saturating_add(estimate.temporary_bytes, size);
            reads.push_back({.kind = kind,
                             .required = required,
                             .read = std::make_unique<assets::detail::IncrementalAssetRead>(
                                 assets, path, "assets.font_source_preparation")});
        };
        if (!prepared.family.regular.asset_path.empty()) {
            append(FaceKind::Regular, prepared.family.regular, true);
        }
        append(FaceKind::Bold, prepared.family.bold, false);
        append(FaceKind::Italic, prepared.family.italic, false);
        append(FaceKind::BoldItalic, prepared.family.bold_italic, false);
    }

    FontSourcePreparationOwner& owner;
    assets::FontAssetRequest request;
    PreparedFontSource prepared;
    std::vector<FaceRead> reads;
    assets::ResidencyCost estimate;
    std::size_t current = 0;
    bool ready = false;
    bool finalized = false;
};

FontSourcePreparationTask::FontSourcePreparationTask(const assets::AssetManager& assets,
                                                     FontSourcePreparationOwner& owner,
                                                     assets::FontAssetRequest request,
                                                     FontFamilyDesc family)
    : m_impl(std::make_unique<Impl>(assets, owner, std::move(request), std::move(family)))
{
}

FontSourcePreparationTask::~FontSourcePreparationTask() = default;

assets::ResidencyCost FontSourcePreparationTask::estimated_cost_on_owner() const noexcept
{
    return m_impl->estimate;
}

jobs::JobStepOutcome FontSourcePreparationTask::step(jobs::JobContext& context) noexcept
{
    if (context.cancellation_requested())
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    if (m_impl->reads.empty()) {
        return {.status = jobs::JobStepStatus::Failed,
                .diagnostics = {{.code = "assets.font_source_preparation.no_source",
                                 .message = "font family has no readable regular source"}}};
    }
    if (m_impl->current >= m_impl->reads.size()) {
        m_impl->ready = true;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }

    auto& current = m_impl->reads[m_impl->current];
    auto outcome = current.read->step(context);
    if (outcome.status == jobs::JobStepStatus::Failed) {
        if (current.required)
            return outcome;
        ++m_impl->current;
        if (m_impl->current == m_impl->reads.size()) {
            m_impl->ready = true;
            return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
        }
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
    }
    if (!current.read->ready())
        return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};

    auto bytes = current.read->take_bytes();
    switch (current.kind) {
    case Impl::FaceKind::Regular:
        m_impl->prepared.regular = std::move(bytes);
        break;
    case Impl::FaceKind::Bold:
        m_impl->prepared.bold = std::move(bytes);
        break;
    case Impl::FaceKind::Italic:
        m_impl->prepared.italic = std::move(bytes);
        break;
    case Impl::FaceKind::BoldItalic:
        m_impl->prepared.bold_italic = std::move(bytes);
        break;
    }
    ++m_impl->current;
    if (m_impl->current == m_impl->reads.size()) {
        m_impl->ready = true;
        return {.status = jobs::JobStepStatus::Completed, .diagnostics = {}};
    }
    return {.status = jobs::JobStepStatus::Yielded, .diagnostics = {}};
}

core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>
FontSourcePreparationTask::finalize_on_owner() noexcept
{
    if (!m_impl->ready || m_impl->finalized || m_impl->prepared.regular.empty()) {
        return preparation_failure<assets::FontAsset>(
            "assets.font_source_preparation.not_ready",
            "font source preparation was finalized before it was ready");
    }
    m_impl->finalized = true;
    return m_impl->owner.finalize_font_source_on_owner(std::move(m_impl->request),
                                                       std::move(m_impl->prepared));
}

TextFontAssetLoader::TextFontAssetLoader(const assets::AssetManager& assets,
                                         TextEngine& text_engine)
    : m_assets(assets), m_text_engine(text_engine),
      m_residency_state(std::make_shared<FontSourceResidencyState>(
          FontSourceResidencyState{.engine = &text_engine}))
{
}

TextFontAssetLoader::~TextFontAssetLoader()
{
    m_assets.bind_font_loader(nullptr);
    m_residency_state->engine = nullptr;
}

void TextFontAssetLoader::set_default_alias(std::string alias)
{
    m_default_alias = alias.empty() ? std::string(kSystemFontAlias) : std::move(alias);
}

void TextFontAssetLoader::ensure_configured_families()
{
    const auto& config = m_assets.font_config();
    if (!config.default_alias.empty()) {
        m_default_alias = config.default_alias;
    }

    for (const auto& family_desc : config.families) {
        if (family_desc.alias.empty() || family_desc.regular.asset_path.empty()) {
            continue;
        }
        if (std::find(m_registered_family_aliases.begin(), m_registered_family_aliases.end(),
                      family_desc.alias) != m_registered_family_aliases.end()) {
            continue;
        }
        if (auto handle = m_text_engine.register_font_family(to_font_family_desc(family_desc))) {
            m_registered_family_aliases.push_back(family_desc.alias);
            if (family_desc.alias == m_default_alias) {
                m_text_engine.set_default_font_family(handle);
            }
        }
    }
}

FontFamilyHandle TextFontAssetLoader::ensure_system_family()
{
    if (m_system_family) {
        return m_system_family;
    }

    std::string font_asset;
    if (m_assets.exists(kSystemFontProjectAsset)) {
        font_asset = std::string(kSystemFontProjectAsset);
    } else if (m_assets.exists(kSystemFontAsset)) {
        font_asset = std::string(kSystemFontAsset);
    } else {
        return {};
    }

    FontFamilyDesc family;
    family.alias = std::string(kSystemFontAlias);
    family.regular = FontDesc{.asset_path = font_asset};
    family.synthetic_styles = true;
    m_system_family = m_text_engine.register_font_family(family);
    return m_system_family;
}

assets::AssetLoadResult<assets::FontAsset>
TextFontAssetLoader::load_font(const assets::FontAssetRequest& request)
{
    ensure_configured_families();
    const auto system_family = ensure_system_family();
    if (!system_family) {
        return fail<assets::FontAsset>(
            "failed to load system font family: no project/system font asset");
    }

    if (m_text_engine.default_font_family() != system_family &&
        m_default_alias == kSystemFontAlias) {
        m_text_engine.set_default_font_family(system_family);
    }

    std::string alias = request.alias.empty() ? m_default_alias : request.alias;
    if (alias == std::string(kSystemFontDisplayName) || alias == "runtime-ui") {
        alias = std::string(kSystemFontAlias);
    }

    auto resolved = m_text_engine.resolve_font(alias, request.style);
    if (!resolved.face && alias != kSystemFontAlias) {
        resolved = m_text_engine.resolve_font(std::string(kSystemFontAlias), request.style);
    }
    if (!resolved.face) {
        return fail<assets::FontAsset>("failed to resolve font alias '" + alias + "'");
    }

    const auto family =
        alias == kSystemFontAlias ? system_family : m_text_engine.default_font_family();
    return {assets::FontAsset{.face = resolved.face,
                              .family = family,
                              .resolved_alias = resolved.alias,
                              .requested_style = resolved.requested_style,
                              .synthetic_style = resolved.synthetic_style},
            {}};
}

std::optional<FontFamilyDesc>
TextFontAssetLoader::preparation_family_for_request(const assets::FontAssetRequest& request) const
{
    std::string alias = request.alias.empty() ? m_default_alias : request.alias;
    if (alias.empty())
        alias = m_assets.default_font_alias();
    if (alias == std::string(kSystemFontDisplayName) || alias == "runtime-ui")
        alias = std::string(kSystemFontAlias);

    if (alias != kSystemFontAlias) {
        const auto& families = m_assets.font_config().families;
        const auto found = std::find_if(families.begin(), families.end(), [&](const auto& family) {
            return family.alias == alias && !family.regular.asset_path.empty();
        });
        if (found != families.end())
            return to_font_family_desc(*found);
    }

    std::string system_path;
    if (m_assets.exists(kSystemFontProjectAsset))
        system_path = std::string(kSystemFontProjectAsset);
    else if (m_assets.exists(kSystemFontAsset))
        system_path = std::string(kSystemFontAsset);
    if (system_path.empty())
        return std::nullopt;

    FontFamilyDesc family;
    family.alias = std::string(kSystemFontAlias);
    family.regular = FontDesc{.asset_path = std::move(system_path)};
    family.synthetic_styles = true;
    return family;
}

std::unique_ptr<assets::AssetPreparationTask<assets::FontAsset>>
TextFontAssetLoader::create_font_preparation_task(const assets::FontAssetRequest& request)
{
    auto resolved = request;
    if (resolved.alias.empty())
        resolved.alias = m_assets.default_font_alias();
    auto family = preparation_family_for_request(resolved);
    if (family)
        resolved.alias = family->alias;
    auto& owner = static_cast<FontSourcePreparationOwner&>(*this);
    return std::make_unique<FontSourcePreparationTask>(m_assets, owner, std::move(resolved),
                                                       family.value_or(FontFamilyDesc{}));
}

core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>
TextFontAssetLoader::finalize_font_source_on_owner(assets::FontAssetRequest request,
                                                   PreparedFontSource prepared) noexcept
{
    const std::uint64_t source_bytes = prepared.total_source_bytes();
    FontFamilySourceBytes sources;
    sources.regular = std::move(prepared.regular);
    sources.bold = std::move(prepared.bold);
    sources.italic = std::move(prepared.italic);
    sources.bold_italic = std::move(prepared.bold_italic);
    const auto family =
        m_text_engine.register_private_font_family(std::move(prepared.family), std::move(sources));
    if (!family) {
        return preparation_failure<assets::FontAsset>(
            "assets.font_source_preparation.font_engine_failed",
            "FreeType/HarfBuzz could not create the prepared font family");
    }

    auto resolved = m_text_engine.resolve_font(family, request.style);
    if (!resolved.face) {
        (void)m_text_engine.unregister_font_family(family);
        return preparation_failure<assets::FontAsset>(
            "assets.font_source_preparation.resolve_failed",
            "prepared font family could not resolve the requested style");
    }

    auto residency_state = m_residency_state;
    return core::Result<assets::PreparedAsset<assets::FontAsset>, core::Diagnostics>::success(
        {.asset = assets::FontAsset{.face = resolved.face,
                                    .family = family,
                                    .resolved_alias = resolved.alias,
                                    .requested_style = resolved.requested_style,
                                    .synthetic_style = resolved.synthetic_style},
         .cost = {.source_bytes = source_bytes},
         .destroy_on_owner = [residency_state = std::move(residency_state),
                              family](assets::FontAsset& asset) {
             if (residency_state->engine != nullptr)
                 (void)residency_state->engine->unregister_font_family(family);
             asset.face = {};
             asset.family = {};
         }});
}

} // namespace noveltea::text
