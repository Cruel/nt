#include "noveltea/assets/mandatory_asset_gate.hpp"
#include "noveltea/runtime/flow_prediction.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <limits>
#include <sstream>
#include <type_traits>
#include <utility>

namespace noveltea::assets {
namespace {

using StructuredAssetRequestHandle =
    std::variant<AssetRequestHandle<FontAsset>, AssetRequestHandle<TextureAsset>,
                 AssetRequestHandle<HotspotMaskAsset>, AssetRequestHandle<ShaderProgramAsset>,
                 AssetRequestHandle<MaterialAsset>, AssetRequestHandle<AudioAsset>>;

struct PendingRecord {
    StructuredAssetRequestDescriptor descriptor;
    StructuredAssetRequestHandle handle;
};

std::atomic<std::uint64_t> s_next_loading_operation{1};

core::LoadingOperationId allocate_loading_operation() noexcept
{
    const auto value = s_next_loading_operation.fetch_add(1, std::memory_order_relaxed);
    if (value == 0 || value == std::numeric_limits<std::uint64_t>::max()) {
        s_next_loading_operation.store(2, std::memory_order_relaxed);
        return {1};
    }
    return {value};
}

core::Diagnostic group_diagnostic(std::string code, std::string message)
{
    return {.code = std::move(code), .message = std::move(message)};
}

std::string_view publication_diagnostic_code(MandatoryPublicationScopeKind scope) noexcept
{
    return scope == MandatoryPublicationScopeKind::Runtime
               ? std::string_view{"assets.mandatory_publication.runtime"}
               : std::string_view{"assets.mandatory_publication.focused_preview"};
}

std::string logical_project_path(std::string_view path)
{
    if (path.starts_with("project:/") || path.starts_with("system:/"))
        return std::string(path);
    return "project:/" + std::string(path);
}

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
core::AssetProfilerPredictionRoot prediction_root(runtime::FlowPredictionRootKind kind) noexcept
{
    switch (kind) {
    case runtime::FlowPredictionRootKind::FlowExecution:
        return core::AssetProfilerPredictionRoot::FlowExecution;
    case runtime::FlowPredictionRootKind::ProspectiveRoomEntry:
        return core::AssetProfilerPredictionRoot::ProspectiveRoomEntry;
    case runtime::FlowPredictionRootKind::ResidentRoomContext:
        return core::AssetProfilerPredictionRoot::ResidentRoomContext;
    }
    return core::AssetProfilerPredictionRoot::FlowExecution;
}

std::string prediction_point_name(const core::compiled::FlowPredictionPoint& point)
{
    return std::visit(
        [](const auto& value) -> std::string {
            using T = std::decay_t<decltype(value)>;
            if constexpr (std::is_same_v<T, core::compiled::SceneEntryPredictionPoint>) {
                return "scene:" + value.scene.text() + ":entry";
            } else if constexpr (std::is_same_v<T, core::compiled::SceneStepPredictionPoint>) {
                return "scene:" + value.scene.text() + ":step:" + value.step.text();
            } else if constexpr (std::is_same_v<T, core::compiled::SceneTerminalPredictionPoint>) {
                return "scene:" + value.scene.text() + ":terminal";
            } else if constexpr (std::is_same_v<T, core::compiled::DialogueEntryPredictionPoint>) {
                return "dialogue:" + value.dialogue.text() + ":entry";
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::DialoguePositionPredictionPoint>) {
                std::string_view stage = "enter-block";
                switch (value.stage) {
                case core::compiled::DialoguePredictionStage::EnterBlock:
                    break;
                case core::compiled::DialoguePredictionStage::PresentSegment:
                    stage = "present-segment";
                    break;
                case core::compiled::DialoguePredictionStage::ApplySegmentEffects:
                    stage = "apply-segment-effects";
                    break;
                case core::compiled::DialoguePredictionStage::PresentChoices:
                    stage = "present-choices";
                    break;
                case core::compiled::DialoguePredictionStage::ApplyChoiceEffects:
                    stage = "apply-choice-effects";
                    break;
                case core::compiled::DialoguePredictionStage::FollowEdge:
                    stage = "follow-edge";
                    break;
                }
                auto result = "dialogue:" + value.dialogue.text() + ":block:" + value.block.text() +
                              ":" + std::string(stage) + ":cursor:" + std::to_string(value.cursor);
                if (value.segment)
                    result += ":segment:" + value.segment->text();
                if (value.edge)
                    result += ":edge:" + value.edge->text();
                return result;
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::DialogueTerminalPredictionPoint>) {
                return "dialogue:" + value.dialogue.text() + ":terminal";
            } else if constexpr (std::is_same_v<T, core::compiled::RoomLifecyclePredictionPoint>) {
                std::string_view stage = "presentation";
                switch (value.stage) {
                case core::compiled::RoomLifecyclePredictionStage::BeforeLeave:
                    stage = "before-leave";
                    break;
                case core::compiled::RoomLifecyclePredictionStage::BeforeEnter:
                    stage = "before-enter";
                    break;
                case core::compiled::RoomLifecyclePredictionStage::Presentation:
                    break;
                case core::compiled::RoomLifecyclePredictionStage::AfterLeave:
                    stage = "after-leave";
                    break;
                case core::compiled::RoomLifecyclePredictionStage::AfterEnter:
                    stage = "after-enter";
                    break;
                }
                return "room:" + value.room.text() + ":" + std::string(stage);
            } else if constexpr (std::is_same_v<T,
                                                core::compiled::InteractionRulePredictionPoint>) {
                return "interaction:" + value.interaction.text() + ":rule:" + value.rule.text();
            } else if constexpr (std::is_same_v<T, core::compiled::VerbDefaultPredictionPoint>) {
                return "verb:" + value.verb.text() + ":default";
            } else if constexpr (std::is_same_v<T, core::compiled::ResidentLayoutPredictionPoint>) {
                return "layout:" + value.layout.text() + ":resident";
            } else {
                return "interaction:undefined";
            }
        },
        point);
}
#endif

AudioClipKind audio_kind(core::compiled::AudioPurpose channel) noexcept
{
    switch (channel) {
    case core::compiled::AudioPurpose::SoundEffect:
        return AudioClipKind::Sfx;
    case core::compiled::AudioPurpose::Music:
        return AudioClipKind::Music;
    case core::compiled::AudioPurpose::Voice:
        return AudioClipKind::Voice;
    case core::compiled::AudioPurpose::Ambience:
        return AudioClipKind::Ambience;
    case core::compiled::AudioPurpose::UiSound:
        return AudioClipKind::Sfx;
    }
    return AudioClipKind::Auto;
}

bool same_scene_prediction_root(const runtime::ActiveScenePredictionRoot& left,
                                const runtime::ActiveScenePredictionRoot& right) noexcept
{
    if (left.scene != right.scene ||
        left.position.stage_initialized != right.position.stage_initialized ||
        left.position.next_step != right.position.next_step ||
        left.position.substate.index() != right.position.substate.index())
        return false;

    return std::visit(
        [&](const auto& left_substate) {
            using T = std::decay_t<decltype(left_substate)>;
            const auto* right_substate = std::get_if<T>(&right.position.substate);
            if (right_substate == nullptr)
                return false;
            if constexpr (std::is_same_v<T, core::SceneInstructionCompletionPosition>) {
                // Only the continuation cursor affects prediction; completion metadata is runtime
                // bookkeeping and must not churn speculative generations.
                return left_substate.next_step == right_substate->next_step;
            } else if constexpr (std::is_same_v<T, core::SceneAutosavePendingPosition>) {
                return left_substate.next_step == right_substate->next_step;
            } else if constexpr (std::is_same_v<T, core::SceneChoiceEffectPosition>) {
                return left_substate.option == right_substate->option &&
                       left_substate.next_effect == right_substate->next_effect;
            } else {
                return true;
            }
        },
        left.position.substate);
}

bool same_dialogue_prediction_root(const runtime::ActiveDialoguePredictionRoot& left,
                                   const runtime::ActiveDialoguePredictionRoot& right) noexcept
{
    if (left.dialogue != right.dialogue || left.position.block != right.position.block ||
        left.position.segment != right.position.segment ||
        left.position.edge != right.position.edge || left.position.stage != right.position.stage)
        return false;

    switch (left.position.stage) {
    case core::DialogueFramePosition::Stage::PresentSegment:
        // Text reveal offset is presentation microstate. Only crossing a cue or entering/leaving a
        // completion wait changes the prediction root.
        return left.position.next_cue == right.position.next_cue &&
               left.position.awaiting_completion == right.position.awaiting_completion;
    case core::DialogueFramePosition::Stage::ApplySegmentEffects:
    case core::DialogueFramePosition::Stage::ApplyChoiceEffects:
        return left.position.next_effect == right.position.next_effect &&
               left.position.effect_command == right.position.effect_command &&
               left.position.awaiting_completion == right.position.awaiting_completion;
    default:
        return true;
    }
}

template<class T>
const AssetLease<T>* find_lease(const std::vector<StructuredAssetLeaseRecord>& records,
                                const AssetCacheKey& key) noexcept
{
    for (const auto& record : records) {
        const auto* lease = std::get_if<AssetLease<T>>(&record.lease);
        if (lease != nullptr && lease->cache_key() == key)
            return lease;
    }
    return nullptr;
}

template<class T>
const AssetLease<T>* find_lease_by_identity(const std::vector<StructuredAssetLeaseRecord>& records,
                                            std::string_view stable_identity) noexcept
{
    for (const auto& record : records) {
        const auto* lease = std::get_if<AssetLease<T>>(&record.lease);
        if (lease != nullptr && lease->cache_key().stable_identity == stable_identity)
            return lease;
    }
    return nullptr;
}

core::Result<StructuredAssetRequestHandle, core::Diagnostic>
submit_request(AssetManager& assets, const StructuredAssetRequestDescriptor& descriptor,
               AssetRequestReason reason) noexcept
{
    return std::visit(
        [&](const auto& request) -> core::Result<StructuredAssetRequestHandle, core::Diagnostic> {
            using T = std::decay_t<decltype(request)>;
            if constexpr (std::is_same_v<T, FontAssetRequest>) {
                auto result = assets.request_font(request, reason);
                if (!result)
                    return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::failure(
                        std::move(result).error());
                return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::success(
                    StructuredAssetRequestHandle{std::move(*result.value_if())});
            } else if constexpr (std::is_same_v<T, TextureAssetRequest>) {
                auto result = assets.request_texture(request, reason);
                if (!result)
                    return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::failure(
                        std::move(result).error());
                return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::success(
                    StructuredAssetRequestHandle{std::move(*result.value_if())});
            } else if constexpr (std::is_same_v<T, HotspotMaskAssetRequest>) {
                auto result = assets.request_hotspot_mask(request, reason);
                if (!result)
                    return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::failure(
                        std::move(result).error());
                return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::success(
                    StructuredAssetRequestHandle{std::move(*result.value_if())});
            } else if constexpr (std::is_same_v<T, ShaderProgramAssetRequest>) {
                auto result = assets.request_shader_program(request, reason);
                if (!result)
                    return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::failure(
                        std::move(result).error());
                return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::success(
                    StructuredAssetRequestHandle{std::move(*result.value_if())});
            } else if constexpr (std::is_same_v<T, MaterialAssetRequest>) {
                auto result = assets.request_material(request, reason);
                if (!result)
                    return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::failure(
                        std::move(result).error());
                return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::success(
                    StructuredAssetRequestHandle{std::move(*result.value_if())});
            } else {
                auto result = assets.request_audio(request, reason);
                if (!result)
                    return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::failure(
                        std::move(result).error());
                return core::Result<StructuredAssetRequestHandle, core::Diagnostic>::success(
                    StructuredAssetRequestHandle{std::move(*result.value_if())});
            }
        },
        descriptor.request);
}

AssetRequestState request_state(const StructuredAssetRequestHandle& handle) noexcept
{
    return std::visit([](const auto& value) { return value.state(); }, handle);
}

core::Diagnostics request_diagnostics(const StructuredAssetRequestHandle& handle)
{
    return std::visit([](const auto& value) { return value.diagnostics(); }, handle);
}

AssetRequestId request_id(const StructuredAssetRequestHandle& handle) noexcept
{
    return std::visit([](const auto& value) { return value.id(); }, handle);
}

void cancel_request(StructuredAssetRequestHandle& handle) noexcept
{
    std::visit([](auto& value) { value.cancel(); }, handle);
}

std::optional<StructuredAssetLease>
take_ready_request(StructuredAssetRequestHandle&& handle) noexcept
{
    return std::visit(
        [](auto&& value) -> std::optional<StructuredAssetLease> {
            auto lease = std::move(value).take_ready();
            if (!lease)
                return std::nullopt;
            return StructuredAssetLease{std::move(*lease)};
        },
        std::move(handle));
}

MandatoryAssetGateResult gate_result(const MandatoryAssetRequestGroup* group)
{
    if (group == nullptr)
        return {};
    switch (group->state_on_owner()) {
    case MandatoryAssetGroupState::Pending:
        return {.disposition = MandatoryAssetGateDisposition::Pending, .diagnostics = {}};
    case MandatoryAssetGroupState::Ready:
        return {.disposition = MandatoryAssetGateDisposition::Ready, .diagnostics = {}};
    case MandatoryAssetGroupState::Failed:
        return {.disposition = MandatoryAssetGateDisposition::Failed,
                .diagnostics = group->progress_on_owner().diagnostics};
    case MandatoryAssetGroupState::Canceled:
        return {.disposition = MandatoryAssetGateDisposition::Canceled,
                .diagnostics = group->progress_on_owner().diagnostics};
    }
    return {};
}

} // namespace

StructuredAssetLeaseSet::StructuredAssetLeaseSet(
    std::vector<StructuredAssetLeaseRecord> records) noexcept
    : m_records(std::move(records))
{
}

std::size_t StructuredAssetLeaseSet::size() const noexcept { return m_records.size(); }
bool StructuredAssetLeaseSet::empty() const noexcept { return m_records.empty(); }

const AssetLease<FontAsset>*
StructuredAssetLeaseSet::find_font(const AssetCacheKey& key) const noexcept
{
    return find_lease<FontAsset>(m_records, key);
}

const AssetLease<FontAsset>*
StructuredAssetLeaseSet::find_font_by_identity(std::string_view stable_identity) const noexcept
{
    return find_lease_by_identity<FontAsset>(m_records, stable_identity);
}

const AssetLease<TextureAsset>*
StructuredAssetLeaseSet::find_texture(const AssetCacheKey& key) const noexcept
{
    return find_lease<TextureAsset>(m_records, key);
}

const AssetLease<TextureAsset>*
StructuredAssetLeaseSet::find_texture_by_identity(std::string_view stable_identity) const noexcept
{
    return find_lease_by_identity<TextureAsset>(m_records, stable_identity);
}

const AssetLease<HotspotMaskAsset>*
StructuredAssetLeaseSet::find_hotspot_mask(const AssetCacheKey& key) const noexcept
{
    return find_lease<HotspotMaskAsset>(m_records, key);
}

const AssetLease<HotspotMaskAsset>* StructuredAssetLeaseSet::find_hotspot_mask_by_identity(
    std::string_view stable_identity) const noexcept
{
    return find_lease_by_identity<HotspotMaskAsset>(m_records, stable_identity);
}

const AssetLease<ShaderProgramAsset>*
StructuredAssetLeaseSet::find_shader_program(const AssetCacheKey& key) const noexcept
{
    return find_lease<ShaderProgramAsset>(m_records, key);
}

const AssetLease<ShaderProgramAsset>* StructuredAssetLeaseSet::find_shader_program_by_identity(
    std::string_view stable_identity) const noexcept
{
    return find_lease_by_identity<ShaderProgramAsset>(m_records, stable_identity);
}

const AssetLease<MaterialAsset>*
StructuredAssetLeaseSet::find_material(const AssetCacheKey& key) const noexcept
{
    return find_lease<MaterialAsset>(m_records, key);
}

const AssetLease<MaterialAsset>*
StructuredAssetLeaseSet::find_material_by_identity(std::string_view stable_identity) const noexcept
{
    return find_lease_by_identity<MaterialAsset>(m_records, stable_identity);
}

const AssetLease<AudioAsset>*
StructuredAssetLeaseSet::find_audio(const AssetCacheKey& key) const noexcept
{
    return find_lease<AudioAsset>(m_records, key);
}

const AssetLease<AudioAsset>*
StructuredAssetLeaseSet::find_audio_by_identity(std::string_view stable_identity) const noexcept
{
    return find_lease_by_identity<AudioAsset>(m_records, stable_identity);
}

std::string StructuredAssetLeaseSet::describe_texture_keys() const
{
    std::ostringstream output;
    bool first = true;
    for (const auto& record : m_records) {
        const auto* lease = std::get_if<AssetLease<TextureAsset>>(&record.lease);
        if (lease == nullptr)
            continue;
        if (!first)
            output << ", ";
        first = false;
        const auto& key = lease->cache_key();
        output << key.stable_identity << "@" << key.source_generation.value;
    }
    return first ? "<none>" : output.str();
}

struct MandatoryAssetRequestGroup::Impl {
    Impl(AssetManager& manager, std::vector<StructuredAssetRequestDescriptor> descriptors,
         MandatoryAssetGroupOptions configured_options, Clock::time_point start) noexcept
        : assets(manager), requests(std::move(descriptors)), options(configured_options),
          started_at(start)
    {
        begin_on_owner(start);
    }

    ~Impl() { close_wait(Clock::now(), core::AssetWaitResult::Canceled); }

    void begin_on_owner(Clock::time_point now) noexcept
    {
        pending.clear();
        ready_leases.reset();
        state = MandatoryAssetGroupState::Pending;
        started_at = now;
        immediate_overlay = options.show_overlay_immediately;
        progress = {.operation = allocate_loading_operation(),
                    .phase = options.phase,
                    .state = core::LoadingState::Active,
                    .completed_units = 0,
                    .total_units = requests.size(),
                    .retryable = false,
                    .diagnostics = {}};

        for (const auto& descriptor : requests) {
            auto submitted = submit_request(assets, descriptor, options.reason);
            if (!submitted) {
                progress.diagnostics.push_back(std::move(submitted).error());
                fail_on_owner();
                return;
            }
            pending.push_back({descriptor, std::move(*submitted.value_if())});
        }
        if (pending.empty()) {
            state = MandatoryAssetGroupState::Ready;
            progress.state = core::LoadingState::Completed;
            progress.retryable = false;
            ready_leases.emplace();
        }
        wait_open = false;
    }

    void open_wait_after_initial_poll(Clock::time_point now) noexcept
    {
        if (wait_open || state != MandatoryAssetGroupState::Pending)
            return;
        initial_waiting.clear();
        for (const auto& record : pending) {
            if (request_state(record.handle) != AssetRequestState::Ready) {
                initial_waiting.push_back({.cache_key = record.descriptor.cache_key,
                                           .request_id = request_id(record.handle)});
            }
        }
        if (initial_waiting.empty())
            return;
        wait_open = true;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (auto* sink = assets.asset_profiler_sink_on_owner()) {
            sink->record_asset_wait_started({.operation = progress.operation,
                                             .phase = progress.phase,
                                             .presentation_revision = options.presentation_revision,
                                             .started_at = started_at,
                                             .waiting_requests = initial_waiting});
        }
#endif
        (void)now;
    }

    void close_wait(Clock::time_point now, core::AssetWaitResult result) noexcept
    {
        if (!wait_open)
            return;
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (auto* sink = assets.asset_profiler_sink_on_owner()) {
            sink->record_asset_wait_finished({.operation = progress.operation,
                                              .finished_at = now,
                                              .result = result,
                                              .diagnostics = progress.diagnostics});
        }
#endif
        wait_open = false;
        initial_waiting.clear();
    }

    void fail_on_owner() noexcept
    {
        for (auto& record : pending)
            cancel_request(record.handle);
        pending.clear();
        state = MandatoryAssetGroupState::Failed;
        progress.state = core::LoadingState::Failed;
        progress.retryable = false;
        if (progress.diagnostics.empty()) {
            progress.diagnostics.push_back(group_diagnostic("assets.mandatory_group_failed",
                                                            "Mandatory asset preparation failed"));
        }
    }

    AssetManager& assets;
    std::vector<StructuredAssetRequestDescriptor> requests;
    MandatoryAssetGroupOptions options;
    Clock::time_point started_at;
    std::vector<PendingRecord> pending;
    std::optional<StructuredAssetLeaseSet> ready_leases;
    core::LoadingProgress progress;
    MandatoryAssetGroupState state = MandatoryAssetGroupState::Pending;
    bool immediate_overlay = false;
    bool leases_taken = false;
    bool wait_open = false;
    std::vector<core::AssetWaitParticipant> initial_waiting;
};

MandatoryAssetRequestGroup::MandatoryAssetRequestGroup(
    AssetManager& assets, std::vector<StructuredAssetRequestDescriptor> requests,
    MandatoryAssetGroupOptions options, Clock::time_point started_at) noexcept
    : m_impl(std::make_unique<Impl>(assets, std::move(requests), options, started_at))
{
}

MandatoryAssetRequestGroup::~MandatoryAssetRequestGroup() { cancel_on_owner(); }
MandatoryAssetRequestGroup::MandatoryAssetRequestGroup(MandatoryAssetRequestGroup&&) noexcept =
    default;
MandatoryAssetRequestGroup&
MandatoryAssetRequestGroup::operator=(MandatoryAssetRequestGroup&& other) noexcept
{
    if (this == &other)
        return *this;
    cancel_on_owner();
    m_impl = std::move(other.m_impl);
    return *this;
}

void MandatoryAssetRequestGroup::poll_on_owner(Clock::time_point now) noexcept
{
    if (m_impl == nullptr || m_impl->state != MandatoryAssetGroupState::Pending)
        return;

    std::size_t ready_count = 0;
    for (const auto& record : m_impl->pending) {
        const auto state = request_state(record.handle);
        if (state == AssetRequestState::Ready) {
            ++ready_count;
            continue;
        }
        if (state == AssetRequestState::Failed || state == AssetRequestState::Canceled) {
            auto diagnostics = request_diagnostics(record.handle);
            if (diagnostics.empty()) {
                diagnostics.push_back(group_diagnostic(
                    state == AssetRequestState::Canceled ? "assets.mandatory_request_canceled"
                                                         : "assets.mandatory_request_failed",
                    "A mandatory typed asset request reached a terminal state"));
            }
            core::append_diagnostics(m_impl->progress.diagnostics, std::move(diagnostics));
            m_impl->progress.completed_units = ready_count;
            m_impl->fail_on_owner();
            m_impl->close_wait(now, core::AssetWaitResult::Failed);
            return;
        }
    }

    m_impl->progress.completed_units = ready_count;
    if (ready_count != m_impl->pending.size()) {
        m_impl->open_wait_after_initial_poll(now);
        return;
    }

    std::vector<StructuredAssetLeaseRecord> leases;
    leases.reserve(m_impl->pending.size());
    for (auto& record : m_impl->pending) {
        auto lease = take_ready_request(std::move(record.handle));
        if (!lease) {
            m_impl->progress.diagnostics.push_back(group_diagnostic(
                "assets.mandatory_ready_lease_missing",
                "A Ready mandatory request could not transfer its reservation pin to a lease"));
            m_impl->fail_on_owner();
            m_impl->close_wait(now, core::AssetWaitResult::Failed);
            return;
        }
        leases.push_back({std::move(record.descriptor), std::move(*lease)});
    }
    m_impl->pending.clear();
    m_impl->ready_leases.emplace(std::move(leases));
    m_impl->state = MandatoryAssetGroupState::Ready;
    m_impl->progress.completed_units = m_impl->requests.size();
    m_impl->progress.state = core::LoadingState::Completed;
    m_impl->progress.retryable = false;
    m_impl->close_wait(now, core::AssetWaitResult::Completed);
}

void MandatoryAssetRequestGroup::cancel_on_owner() noexcept
{
    if (m_impl == nullptr || m_impl->state == MandatoryAssetGroupState::Canceled)
        return;
    for (auto& record : m_impl->pending)
        cancel_request(record.handle);
    m_impl->pending.clear();
    m_impl->ready_leases.reset();
    m_impl->state = MandatoryAssetGroupState::Canceled;
    m_impl->progress.state = core::LoadingState::Canceled;
    m_impl->progress.retryable = false;
    m_impl->close_wait(Clock::now(), core::AssetWaitResult::Canceled);
}

void MandatoryAssetRequestGroup::show_overlay_immediately_on_owner() noexcept
{
    if (m_impl != nullptr)
        m_impl->immediate_overlay = true;
}

MandatoryAssetGroupState MandatoryAssetRequestGroup::state_on_owner() const noexcept
{
    return m_impl == nullptr ? MandatoryAssetGroupState::Canceled : m_impl->state;
}

const core::LoadingProgress& MandatoryAssetRequestGroup::progress_on_owner() const noexcept
{
    static const core::LoadingProgress empty{};
    return m_impl == nullptr ? empty : m_impl->progress;
}

bool MandatoryAssetRequestGroup::overlay_visible_on_owner(Clock::time_point now) const noexcept
{
    if (m_impl == nullptr || m_impl->state == MandatoryAssetGroupState::Ready ||
        m_impl->state == MandatoryAssetGroupState::Canceled)
        return false;
    if (m_impl->state == MandatoryAssetGroupState::Failed || m_impl->immediate_overlay)
        return true;
    return now - m_impl->started_at >= m_impl->options.overlay_grace;
}

std::optional<StructuredAssetLeaseSet>
MandatoryAssetRequestGroup::take_ready_leases_on_owner() noexcept
{
    if (m_impl == nullptr || m_impl->state != MandatoryAssetGroupState::Ready ||
        m_impl->leases_taken || !m_impl->ready_leases)
        return std::nullopt;
    m_impl->leases_taken = true;
    return std::move(m_impl->ready_leases);
}

MandatoryPublicationTransaction::MandatoryPublicationTransaction(
    MandatoryPublicationScope& scope, AssetSourceGeneration source_generation) noexcept
    : m_scope(&scope), m_source_generation(source_generation)
{
}

MandatoryPublicationTransaction::~MandatoryPublicationTransaction() { rollback_on_owner(); }

MandatoryPublicationTransaction::MandatoryPublicationTransaction(
    MandatoryPublicationTransaction&& other) noexcept
    : m_scope(std::exchange(other.m_scope, nullptr)), m_source_generation(other.m_source_generation)
{
}

MandatoryPublicationTransaction&
MandatoryPublicationTransaction::operator=(MandatoryPublicationTransaction&& other) noexcept
{
    if (this == &other)
        return *this;
    rollback_on_owner();
    m_scope = std::exchange(other.m_scope, nullptr);
    m_source_generation = other.m_source_generation;
    return *this;
}

core::DiagnosticResult<void>
MandatoryPublicationTransaction::commit_on_owner(bool retain_predecessor) noexcept
{
    if (m_scope == nullptr) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.mandatory_publication_transaction_inactive",
             .message = "Mandatory publication transaction is no longer active"});
    }
    auto committed = m_scope->commit_candidate_on_owner(m_source_generation, retain_predecessor);
    if (committed)
        m_scope = nullptr;
    return committed;
}

void MandatoryPublicationTransaction::rollback_on_owner() noexcept
{
    if (m_scope == nullptr)
        return;
    m_scope->rollback_candidate_on_owner();
    m_scope = nullptr;
}

bool MandatoryPublicationTransaction::active_on_owner() const noexcept
{
    return m_scope != nullptr;
}

MandatoryPublicationScope::MandatoryPublicationScope(AssetManager& assets,
                                                     MandatoryPublicationScopeKind kind) noexcept
    : m_assets(assets), m_kind(kind)
{
}

MandatoryPublicationScope::~MandatoryPublicationScope() { clear_on_owner(); }

MandatoryPublicationTransaction MandatoryPublicationScope::begin_transaction_on_owner(
    StructuredAssetLeaseSet leases, AssetSourceGeneration source_generation) noexcept
{
    rollback_candidate_on_owner();
    if (m_kind == MandatoryPublicationScopeKind::Runtime)
        m_assets.stage_candidate_leases_on_owner(std::move(leases));
    else
        m_assets.stage_focused_candidate_leases_on_owner(std::move(leases));
    m_candidate_active = true;
    m_assets.record_lifecycle_telemetry_on_owner(
        core::AssetTelemetryEventKind::MandatoryCandidateStaged,
        publication_diagnostic_code(m_kind));
    return MandatoryPublicationTransaction(*this, source_generation);
}

core::DiagnosticResult<void>
MandatoryPublicationScope::commit_candidate_on_owner(AssetSourceGeneration source_generation,
                                                     bool retain_predecessor) noexcept
{
    if (!m_candidate_active) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.mandatory_publication_candidate_inactive",
             .message = "Mandatory publication candidate is no longer active"});
    }
    if (source_generation != m_assets.source_generation_on_owner()) {
        m_assets.record_lifecycle_telemetry_on_owner(
            core::AssetTelemetryEventKind::MandatoryPublicationStaleGenerationRejected,
            publication_diagnostic_code(m_kind));
        rollback_candidate_on_owner();
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.mandatory_publication_stale_source_generation",
             .message = "Mandatory publication candidate belongs to a retired source generation"});
    }

    if (m_kind == MandatoryPublicationScopeKind::Runtime) {
        m_assets.commit_candidate_leases_on_owner();
        if (!retain_predecessor)
            m_assets.clear_previous_published_leases_on_owner();
    } else {
        m_assets.commit_focused_candidate_leases_on_owner();
    }
    m_candidate_active = false;
    m_assets.record_lifecycle_telemetry_on_owner(
        core::AssetTelemetryEventKind::MandatoryPublicationCommitted,
        publication_diagnostic_code(m_kind));
    return core::DiagnosticResult<void>::success();
}

void MandatoryPublicationScope::rollback_candidate_on_owner() noexcept
{
    if (!m_candidate_active)
        return;
    if (m_kind == MandatoryPublicationScopeKind::Runtime)
        m_assets.rollback_candidate_leases_on_owner();
    else
        m_assets.rollback_focused_candidate_leases_on_owner();
    m_candidate_active = false;
    m_assets.record_lifecycle_telemetry_on_owner(
        core::AssetTelemetryEventKind::MandatoryPublicationRolledBack,
        publication_diagnostic_code(m_kind));
}

void MandatoryPublicationScope::release_predecessor_on_owner() noexcept
{
    if (m_kind == MandatoryPublicationScopeKind::Runtime &&
        m_assets.has_previous_published_leases_on_owner()) {
        m_assets.clear_previous_published_leases_on_owner();
        m_assets.record_lifecycle_telemetry_on_owner(
            core::AssetTelemetryEventKind::MandatoryPredecessorReleased,
            publication_diagnostic_code(m_kind));
    }
}

void MandatoryPublicationScope::clear_on_owner() noexcept
{
    rollback_candidate_on_owner();
    if (m_kind == MandatoryPublicationScopeKind::Runtime)
        m_assets.clear_published_leases_on_owner();
    else
        m_assets.clear_focused_published_leases_on_owner();
}

RuntimeMandatoryPublicationTransaction::RuntimeMandatoryPublicationTransaction(
    MandatoryAssetGate& gate, MandatoryPublicationTransaction transaction) noexcept
    : m_gate(&gate), m_transaction(std::move(transaction))
{
}

RuntimeMandatoryPublicationTransaction::~RuntimeMandatoryPublicationTransaction()
{
    rollback_on_owner();
}

RuntimeMandatoryPublicationTransaction::RuntimeMandatoryPublicationTransaction(
    RuntimeMandatoryPublicationTransaction&& other) noexcept
    : m_gate(std::exchange(other.m_gate, nullptr)), m_transaction(std::move(other.m_transaction))
{
}

RuntimeMandatoryPublicationTransaction& RuntimeMandatoryPublicationTransaction::operator=(
    RuntimeMandatoryPublicationTransaction&& other) noexcept
{
    if (this == &other)
        return *this;
    rollback_on_owner();
    m_gate = std::exchange(other.m_gate, nullptr);
    m_transaction = std::move(other.m_transaction);
    return *this;
}

core::DiagnosticResult<void>
RuntimeMandatoryPublicationTransaction::commit_on_owner(bool retain_predecessor) noexcept
{
    if (m_gate == nullptr || !m_transaction) {
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.mandatory_runtime_transaction_inactive",
             .message = "Runtime mandatory publication transaction is no longer active"});
    }
    auto committed = m_transaction->commit_on_owner(retain_predecessor);
    if (!committed) {
        m_gate->abandon_ready_transaction_on_owner();
        m_gate = nullptr;
        m_transaction.reset();
        return committed;
    }
    m_gate->commit_ready_transaction_on_owner();
    m_gate = nullptr;
    m_transaction.reset();
    return core::DiagnosticResult<void>::success();
}

void RuntimeMandatoryPublicationTransaction::rollback_on_owner() noexcept
{
    if (m_gate == nullptr)
        return;
    if (m_transaction)
        m_transaction->rollback_on_owner();
    m_gate->abandon_ready_transaction_on_owner();
    m_transaction.reset();
    m_gate = nullptr;
}

struct MandatoryAssetGate::Impl {
    explicit Impl(AssetManager& manager) noexcept
        : assets(manager), publication(manager, MandatoryPublicationScopeKind::Runtime),
          prefetch(manager)
    {
    }

    core::DiagnosticResult<void> rebuild_index_on_owner(AssetSourceGeneration generation)
    {
        if (package == nullptr) {
            return core::DiagnosticResult<void>::failure(
                {.code = "assets.mandatory_gate_package_unbound",
                 .message = "Mandatory asset dependency collection requires a bound compiled "
                            "package"});
        }

        auto index =
            StructuredAssetDependencyIndex::build(*package, active_renderer_variant, generation);
        dependency_generation = generation;
        dependency_index.emplace(index);
        collector.emplace(std::move(index));
        return core::DiagnosticResult<void>::success();
    }

    MandatoryAssetDependencyContext
    context_for(const core::RuntimePresentationSnapshot& snapshot) const
    {
        MandatoryAssetDependencyContext context;
        context.current_presentation = &snapshot;
        if (snapshot.mode != core::PresentationRuntimeMode::Ended) {
            context.required_system_layouts.push_back(core::compiled::SystemLayoutRole::GameHud);
            context.required_system_layouts.push_back(
                core::compiled::SystemLayoutRole::CommandBuilder);
            context.required_system_layouts.push_back(core::compiled::SystemLayoutRole::SceneText);
            context.required_system_layouts.push_back(
                core::compiled::SystemLayoutRole::SceneChoice);
        }
        return context;
    }

    void append_adjacent_room_predictions(const core::RuntimePresentationSnapshot& snapshot)
    {
        adjacent_prediction_plan = {};
        if (package == nullptr || !dependency_index || !snapshot.current_room)
            return;
        const auto* room = package->project().find_room(*snapshot.current_room);
        if (room == nullptr)
            return;

        runtime::FlowPredictor predictor(package->project());
        for (const auto& exit : room->exits) {
            auto projection = predictor.predict(runtime::ProspectiveRoomEntryPredictionRoot{
                .source_room = *snapshot.current_room, .target_room = exit.target});
            auto plan = resolve_flow_prediction(*dependency_index, projection);
            core::append_diagnostics(adjacent_prediction_plan.diagnostics,
                                     std::move(plan.diagnostics));
            adjacent_prediction_plan.structural_limit_reached |= plan.structural_limit_reached;
            for (auto& candidate : plan.candidates) {
                // Choosing this exit is itself speculative, so even deterministic work inside the
                // prospective successful transition remains PossibleNext from the current Room.
                candidate.prediction = PrefetchPredictionKind::PossibleNext;
                adjacent_prediction_plan.candidates.push_back(std::move(candidate));
            }
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
            adjacent_prediction_plan.opaque_frontiers.insert(
                adjacent_prediction_plan.opaque_frontiers.end(),
                std::make_move_iterator(plan.opaque_frontiers.begin()),
                std::make_move_iterator(plan.opaque_frontiers.end()));
#endif
        }
    }

    PrefetchPlan speculative_plan() const
    {
        auto result = adjacent_prediction_plan;
        core::append_diagnostics(result.diagnostics, dependencies.diagnostics);
        if (package == nullptr || !dependency_index)
            return result;

        if (resident_prediction) {
            auto resident_plan = resolve_flow_prediction(*dependency_index, *resident_prediction);
            core::append_diagnostics(result.diagnostics, std::move(resident_plan.diagnostics));
            result.structural_limit_reached |= resident_plan.structural_limit_reached;
            result.candidates.insert(result.candidates.end(),
                                     std::make_move_iterator(resident_plan.candidates.begin()),
                                     std::make_move_iterator(resident_plan.candidates.end()));
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
            result.opaque_frontiers.insert(
                result.opaque_frontiers.end(),
                std::make_move_iterator(resident_plan.opaque_frontiers.begin()),
                std::make_move_iterator(resident_plan.opaque_frontiers.end()));
#endif
        }

        const runtime::FlowPredictionProjection* projection = nullptr;
        if (active_scene_prediction)
            projection = &*active_scene_prediction;
        else if (active_dialogue_prediction)
            projection = &*active_dialogue_prediction;
        else if (!runtime_prediction_observed && !entry_prediction.entries.empty())
            projection = &entry_prediction;
        if (projection != nullptr) {
            auto plan = resolve_flow_prediction(*dependency_index, *projection);
            core::append_diagnostics(result.diagnostics, std::move(plan.diagnostics));
            result.structural_limit_reached |= plan.structural_limit_reached;
            result.candidates.insert(result.candidates.end(),
                                     std::make_move_iterator(plan.candidates.begin()),
                                     std::make_move_iterator(plan.candidates.end()));
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
            result.opaque_frontiers.insert(result.opaque_frontiers.end(),
                                           std::make_move_iterator(plan.opaque_frontiers.begin()),
                                           std::make_move_iterator(plan.opaque_frontiers.end()));
#endif
        }
        return result;
    }

#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    void record_prefetch_replacement_on_owner(
        std::optional<PrefetchGenerationId> previous_generation,
        const PrefetchSubmissionReport& report,
        std::optional<core::PresentationSnapshotRevision> presentation_revision) noexcept
    {
        auto* sink = assets.asset_profiler_sink_on_owner();
        if (sink == nullptr)
            return;

        // The planner has already attached/retagged the new interests before this telemetry
        // handoff. Retire the prior logical generation first so the profiler's active-generation
        // view advances atomically to the replacement record below.
        if (previous_generation && *previous_generation != report.generation)
            sink->record_prefetch_generation_released(*previous_generation);

        core::AssetProfilerPrefetchGenerationRecord record;
        record.generation = report.generation;
        record.presentation_revision = presentation_revision;
        record.expected_next_count = report.expected_count;
        record.possible_next_count = report.possible_count;
        record.prediction_plan.reserve(report.ranked_candidates.size());
        for (const auto& candidate : report.ranked_candidates) {
            core::AssetProfilerPrefetchPlanEntry plan_entry;
            plan_entry.cache_key = candidate.descriptor.cache_key;
            plan_entry.prediction = candidate.prediction == PrefetchPredictionKind::ExpectedNext
                                        ? core::PrefetchPredictionKind::ExpectedNext
                                        : core::PrefetchPredictionKind::PossibleNext;
            plan_entry.execution_distance = candidate.execution_distance;
            plan_entry.execution_order = candidate.execution_order;
            plan_entry.dependency_priority = candidate.dependency_priority;
            plan_entry.estimated_cost = candidate.estimated_cost;
            plan_entry.cost_estimate =
                candidate.cost_estimate == PrefetchCostEstimateKind::Metadata
                    ? core::AssetProfilerPredictionCostEstimateKind::Metadata
                    : core::AssetProfilerPredictionCostEstimateKind::Conservative;
            for (const auto& provenance : candidate.provenance) {
                core::AssetProfilerPredictionProvenance flattened;
                flattened.root = prediction_root(provenance.root_kind);
                if (provenance.room)
                    flattened.room = provenance.room->text();
                flattened.supplemental_hint_id = provenance.supplemental_hint_id;
                flattened.reason_chain.reserve(provenance.points.size());
                for (const auto& point : provenance.points)
                    flattened.reason_chain.push_back(prediction_point_name(point));
                plan_entry.provenance.push_back(std::move(flattened));
            }
            record.prediction_plan.push_back(std::move(plan_entry));
        }
        for (const auto& frontier : report.opaque_frontiers) {
            core::AssetProfilerOpaquePredictionFrontier flattened;
            flattened.root = prediction_root(frontier.provenance.root_kind);
            if (frontier.provenance.room)
                flattened.room = frontier.provenance.room->text();
            flattened.attachment_point = prediction_point_name(frontier.attachment_point);
            flattened.reason_chain.reserve(frontier.provenance.points.size());
            for (const auto& point : frontier.provenance.points)
                flattened.reason_chain.push_back(prediction_point_name(point));
            const auto duplicate =
                std::ranges::find_if(record.opaque_frontiers, [&](const auto& existing) {
                    return existing.root == flattened.root && existing.room == flattened.room &&
                           existing.attachment_point == flattened.attachment_point &&
                           existing.reason_chain == flattened.reason_chain;
                });
            if (duplicate == record.opaque_frontiers.end())
                record.opaque_frontiers.push_back(std::move(flattened));
        }
        const auto append_entry = [&](const PrefetchSubmissionEntry& entry) {
            record.submitted_entries.push_back(
                {.cache_key = entry.cache_key,
                 .prediction = entry.prediction == PrefetchPredictionKind::ExpectedNext
                                   ? core::PrefetchPredictionKind::ExpectedNext
                                   : core::PrefetchPredictionKind::PossibleNext});
        };
        for (const auto& entry : report.submitted_entries)
            append_entry(entry);
        // The profiler generation record predates planner reconciliation and models the interests
        // active in one logical generation. Retained tickets therefore belong in this existing
        // collection even though the planner report distinguishes them from newly submitted work.
        for (const auto& entry : report.retained_entries)
            append_entry(entry);

        const auto append_failure = [&](const AssetCacheKey& cache_key,
                                        PrefetchPredictionKind prediction,
                                        const core::Diagnostic& diagnostic) {
            record.submission_failures.push_back(
                {.cache_key = cache_key,
                 .prediction = prediction == PrefetchPredictionKind::ExpectedNext
                                   ? core::PrefetchPredictionKind::ExpectedNext
                                   : core::PrefetchPredictionKind::PossibleNext,
                 .diagnostic = diagnostic});
        };
        for (const auto& failure : report.failures)
            append_failure(failure.cache_key, failure.prediction, failure.diagnostic);
        for (const auto& rejection : report.admission_rejections)
            append_failure(rejection.cache_key, rejection.prediction, rejection.diagnostic);
        sink->record_prefetch_generation(std::move(record));
    }
#endif

    AssetManager& assets;
    MandatoryPublicationScope publication;
    PrefetchPlanner prefetch;
    const core::LoadedCompiledPackage* package = nullptr;
    std::string active_renderer_variant;
    std::optional<StructuredAssetDependencyIndex> dependency_index;
    std::optional<MandatoryAssetDependencyCollector> collector;
    runtime::FlowPredictionProjection entry_prediction;
    std::optional<runtime::ActiveScenePredictionRoot> active_scene_root;
    std::optional<runtime::FlowPredictionProjection> active_scene_prediction;
    std::optional<runtime::ActiveDialoguePredictionRoot> active_dialogue_root;
    std::optional<runtime::FlowPredictionProjection> active_dialogue_prediction;
    std::optional<runtime::ResidentRoomPredictionRoot> resident_root;
    std::optional<runtime::FlowPredictionProjection> resident_prediction;
    bool runtime_prediction_observed = false;
    AssetSourceGeneration dependency_generation;
    std::optional<MandatoryAssetRequestGroup> group;
    MandatoryAssetDependencyClosure dependencies;
    PrefetchPlan adjacent_prediction_plan;
    std::optional<core::PresentationSnapshotRevision> snapshot_revision;
    std::optional<core::RuntimePresentationSnapshot> pending_snapshot;
    bool transaction_active = false;
};

MandatoryAssetGate::MandatoryAssetGate(AssetManager& assets) noexcept
    : m_impl(std::make_unique<Impl>(assets))
{
}

MandatoryAssetGate::~MandatoryAssetGate()
{
    if (m_impl != nullptr)
        clear_package_on_owner();
}
MandatoryAssetGate::MandatoryAssetGate(MandatoryAssetGate&&) noexcept = default;
MandatoryAssetGate& MandatoryAssetGate::operator=(MandatoryAssetGate&& other) noexcept
{
    if (this == &other)
        return *this;
    if (m_impl != nullptr)
        clear_package_on_owner();
    m_impl = std::move(other.m_impl);
    return *this;
}

core::DiagnosticResult<void>
MandatoryAssetGate::bind_package_on_owner(const core::LoadedCompiledPackage& package,
                                          std::string_view active_renderer_variant,
                                          AssetSourceGeneration generation)
{
    rollback_candidate_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto released_generation = m_impl->prefetch.active_generation_on_owner();
#endif
    m_impl->prefetch.clear_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (released_generation) {
        if (auto* sink = m_impl->assets.asset_profiler_sink_on_owner())
            sink->record_prefetch_generation_released(*released_generation);
    }
#endif
    m_impl->active_renderer_variant = std::string(active_renderer_variant);
    if (generation != m_impl->assets.source_generation_on_owner()) {
        m_impl->dependency_index.reset();
        m_impl->collector.reset();
        m_impl->entry_prediction = {};
        m_impl->adjacent_prediction_plan = {};
        m_impl->active_scene_root.reset();
        m_impl->active_scene_prediction.reset();
        m_impl->active_dialogue_root.reset();
        m_impl->active_dialogue_prediction.reset();
        m_impl->resident_root.reset();
        m_impl->resident_prediction.reset();
        m_impl->runtime_prediction_observed = false;
        m_impl->package = nullptr;
        return core::DiagnosticResult<void>::failure(
            {.code = "assets.mandatory_gate_stale_source_generation",
             .message = "Mandatory asset dependency collection targets a stale source generation"});
    }
    auto index =
        StructuredAssetDependencyIndex::build(package, m_impl->active_renderer_variant, generation);
    m_impl->package = &package;
    m_impl->dependency_generation = generation;
    m_impl->dependency_index.emplace(index);
    m_impl->collector.emplace(index);

    // The tracer uses the package entrypoint as its read-only prediction root. Submission still
    // waits for the normal mandatory publication commit boundary.
    runtime::FlowPredictor predictor(package.project());
    m_impl->entry_prediction = predictor.predict(package.project().entrypoint());
    m_impl->adjacent_prediction_plan = {};
    m_impl->active_scene_root.reset();
    m_impl->active_scene_prediction.reset();
    m_impl->active_dialogue_root.reset();
    m_impl->active_dialogue_prediction.reset();
    m_impl->resident_root.reset();
    m_impl->resident_prediction.reset();
    m_impl->runtime_prediction_observed = false;
    return core::DiagnosticResult<void>::success();
}

void MandatoryAssetGate::clear_package_on_owner() noexcept
{
    rollback_candidate_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto released_generation = m_impl->prefetch.active_generation_on_owner();
#endif
    m_impl->prefetch.clear_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (released_generation) {
        if (auto* sink = m_impl->assets.asset_profiler_sink_on_owner())
            sink->record_prefetch_generation_released(*released_generation);
    }
#endif
    m_impl->dependency_index.reset();
    m_impl->collector.reset();
    m_impl->entry_prediction = {};
    m_impl->adjacent_prediction_plan = {};
    m_impl->active_scene_root.reset();
    m_impl->active_scene_prediction.reset();
    m_impl->active_dialogue_root.reset();
    m_impl->active_dialogue_prediction.reset();
    m_impl->resident_root.reset();
    m_impl->resident_prediction.reset();
    m_impl->runtime_prediction_observed = false;
    m_impl->package = nullptr;
    m_impl->active_renderer_variant.clear();
    m_impl->publication.clear_on_owner();
}

MandatoryAssetGateResult
MandatoryAssetGate::begin_on_owner(const core::RuntimePresentationSnapshot& snapshot,
                                   MandatoryAssetRequestGroup::Clock::time_point now) noexcept
{
    if (!m_impl->collector) {
        return {.disposition = MandatoryAssetGateDisposition::Failed,
                .diagnostics = {group_diagnostic(
                    "assets.mandatory_gate_package_unbound",
                    "Mandatory asset dependency collection requires a bound compiled package")}};
    }

    const auto current_generation = m_impl->assets.source_generation_on_owner();
    if (m_impl->dependency_generation != current_generation) {
        // Dependency descriptors embed the source generation in their cache keys. Editor preview
        // asset staging can replace the project namespace after the package was indexed, so rebuild
        // before issuing mandatory requests; otherwise Ready request handles can be stored under a
        // stale descriptor key and become invisible to renderer lease lookup.
        rollback_candidate_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        const auto released_generation = m_impl->prefetch.active_generation_on_owner();
#endif
        m_impl->prefetch.clear_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (released_generation) {
            if (auto* sink = m_impl->assets.asset_profiler_sink_on_owner())
                sink->record_prefetch_generation_released(*released_generation);
        }
#endif
        auto rebuilt = m_impl->rebuild_index_on_owner(current_generation);
        if (!rebuilt) {
            return {.disposition = MandatoryAssetGateDisposition::Failed,
                    .diagnostics = {std::move(rebuilt).error()}};
        }
    }
    if (m_impl->group && m_impl->snapshot_revision == snapshot.revision)
        return gate_result(&*m_impl->group);

    rollback_candidate_on_owner();
    m_impl->dependencies = m_impl->collector->collect(m_impl->context_for(snapshot));
    if (snapshot.mode != core::PresentationRuntimeMode::Room || !snapshot.current_room ||
        !m_impl->resident_root || m_impl->resident_root->room != *snapshot.current_room) {
        m_impl->resident_root.reset();
        m_impl->resident_prediction.reset();
    }
    m_impl->append_adjacent_room_predictions(snapshot);
    if (!m_impl->dependencies.diagnostics.empty()) {
        return {.disposition = MandatoryAssetGateDisposition::Failed,
                .diagnostics = m_impl->dependencies.diagnostics};
    }
    m_impl->snapshot_revision = snapshot.revision;
    m_impl->pending_snapshot = snapshot;
    m_impl->group.emplace(
        m_impl->assets, m_impl->dependencies.requests,
        MandatoryAssetGroupOptions{.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                   .reason = AssetRequestReason::Demand,
                                   .overlay_grace = std::chrono::milliseconds{100},
                                   .show_overlay_immediately = false,
                                   .presentation_revision = snapshot.revision},
        now);
    m_impl->group->poll_on_owner(now);
    return gate_result(&*m_impl->group);
}

MandatoryAssetGateResult
MandatoryAssetGate::poll_on_owner(MandatoryAssetRequestGroup::Clock::time_point now) noexcept
{
    if (!m_impl->group)
        return {};
    const auto current_generation = m_impl->assets.source_generation_on_owner();
    if (m_impl->dependency_generation != current_generation) {
        // A project namespace refresh can happen while a mandatory request group is still loading
        // (notably when editor focused-preview resources advance). Those request handles belong to
        // the retired generation and must never be promoted into the next world publication.
        const auto snapshot = m_impl->pending_snapshot;
        rollback_candidate_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        const auto released_generation = m_impl->prefetch.active_generation_on_owner();
#endif
        m_impl->prefetch.clear_on_owner();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
        if (released_generation) {
            if (auto* sink = m_impl->assets.asset_profiler_sink_on_owner())
                sink->record_prefetch_generation_released(*released_generation);
        }
#endif
        auto rebuilt = m_impl->rebuild_index_on_owner(current_generation);
        if (!rebuilt) {
            return {.disposition = MandatoryAssetGateDisposition::Failed,
                    .diagnostics = {std::move(rebuilt).error()}};
        }
        if (!snapshot) {
            return {.disposition = MandatoryAssetGateDisposition::Failed,
                    .diagnostics = {group_diagnostic(
                        "assets.mandatory_snapshot_missing_after_generation_refresh",
                        "Mandatory asset generation changed without a retained presentation "
                        "snapshot")}};
        }
        return begin_on_owner(*snapshot, now);
    }
    m_impl->group->poll_on_owner(now);
    return gate_result(&*m_impl->group);
}

core::Result<void, core::Diagnostics> MandatoryAssetGate::include_audio_operation_on_owner(
    const core::AudioOperation& operation,
    MandatoryAssetRequestGroup::Clock::time_point now) noexcept
{
    const bool starts_playback = operation.action == core::compiled::AudioAction::Play ||
                                 operation.action == core::compiled::AudioAction::FadeIn;
    if (!starts_playback || operation.causality == core::compiled::AudioCausality::Disposable)
        return core::Result<void, core::Diagnostics>::success();
    if (!m_impl->group || !operation.asset)
        return core::Result<void, core::Diagnostics>::success();
    if (m_impl->package == nullptr) {
        return core::Result<void, core::Diagnostics>::failure(
            {group_diagnostic("assets.mandatory_audio_package_unbound",
                              "Causal audio preparation requires a bound compiled package")});
    }

    const auto* asset = m_impl->package->project().find_asset(*operation.asset);
    if (asset == nullptr) {
        return core::Result<void, core::Diagnostics>::failure({group_diagnostic(
            "assets.mandatory_audio_asset_missing",
            "Causal audio operation references an unknown Asset: " + operation.asset->text())});
    }
    if (asset->kind != core::compiled::AssetKind::Audio) {
        return core::Result<void, core::Diagnostics>::failure({group_diagnostic(
            "assets.mandatory_audio_asset_kind_invalid",
            "Causal audio operation references a non-audio Asset: " + operation.asset->text())});
    }

    AudioAssetRequest request{.path = logical_project_path(asset->path),
                              .mode = AudioLoadMode::Auto,
                              .kind = audio_kind(operation.purpose)};
    StructuredAssetRequestDescriptor descriptor{
        .request = request,
        .cache_key = make_audio_cache_key(request, m_impl->assets.source_generation_on_owner())};
    const auto duplicate = std::find_if(
        m_impl->dependencies.requests.begin(), m_impl->dependencies.requests.end(),
        [&](const auto& current) { return current.cache_key == descriptor.cache_key; });
    if (duplicate != m_impl->dependencies.requests.end()) {
        m_impl->group->show_overlay_immediately_on_owner();
        return core::Result<void, core::Diagnostics>::success();
    }

    m_impl->dependencies.requests.push_back(std::move(descriptor));
    m_impl->group->cancel_on_owner();
    m_impl->group.emplace(
        m_impl->assets, m_impl->dependencies.requests,
        MandatoryAssetGroupOptions{.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                   .reason = AssetRequestReason::Demand,
                                   .overlay_grace = std::chrono::milliseconds{100},
                                   .show_overlay_immediately = true,
                                   .presentation_revision = m_impl->snapshot_revision},
        now);
    return core::Result<void, core::Diagnostics>::success();
}

core::Diagnostics MandatoryAssetGate::update_active_scene_prediction_on_owner(
    const runtime::ActiveScenePredictionRoot* root) noexcept
{
    const bool same_root = root != nullptr && m_impl->active_scene_root &&
                           same_scene_prediction_root(*m_impl->active_scene_root, *root) &&
                           !m_impl->resident_root;
    const bool same_absence = root == nullptr && m_impl->runtime_prediction_observed &&
                              !m_impl->active_scene_root && !m_impl->active_dialogue_root &&
                              !m_impl->resident_root;
    if (same_root || same_absence)
        return {};

    m_impl->runtime_prediction_observed = true;
    m_impl->resident_root.reset();
    m_impl->resident_prediction.reset();
    m_impl->active_dialogue_root.reset();
    m_impl->active_dialogue_prediction.reset();
    m_impl->active_scene_root =
        root != nullptr ? std::optional<runtime::ActiveScenePredictionRoot>{*root} : std::nullopt;
    m_impl->active_scene_prediction.reset();
    if (root != nullptr && m_impl->package != nullptr) {
        runtime::FlowPredictor predictor(m_impl->package->project());
        m_impl->active_scene_prediction = predictor.predict(*root);
    }

    core::Diagnostics diagnostics;
    if (m_impl->active_scene_prediction)
        diagnostics = m_impl->active_scene_prediction->diagnostics;
    if (m_impl->group || m_impl->transaction_active || m_impl->package == nullptr ||
        !m_impl->dependency_index)
        return diagnostics;

    auto plan = m_impl->speculative_plan();
    core::append_diagnostics(diagnostics, std::move(plan.diagnostics));
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto previous_generation = m_impl->prefetch.active_generation_on_owner();
#endif
    auto submitted = m_impl->prefetch.replace_generation_on_owner(plan);
    if (!submitted) {
        diagnostics.push_back(std::move(submitted).error());
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    } else {
        m_impl->record_prefetch_replacement_on_owner(previous_generation, submitted.value(),
                                                     std::nullopt);
#endif
    }
    return diagnostics;
}

core::Diagnostics MandatoryAssetGate::update_active_dialogue_prediction_on_owner(
    const runtime::ActiveDialoguePredictionRoot* root) noexcept
{
    const bool same_root = root != nullptr && m_impl->active_dialogue_root &&
                           same_dialogue_prediction_root(*m_impl->active_dialogue_root, *root) &&
                           !m_impl->resident_root;
    const bool same_absence = root == nullptr && m_impl->runtime_prediction_observed &&
                              !m_impl->active_scene_root && !m_impl->active_dialogue_root &&
                              !m_impl->resident_root;
    if (same_root || same_absence)
        return {};

    m_impl->runtime_prediction_observed = true;
    m_impl->resident_root.reset();
    m_impl->resident_prediction.reset();
    m_impl->active_scene_root.reset();
    m_impl->active_scene_prediction.reset();
    m_impl->active_dialogue_root = root != nullptr
                                       ? std::optional<runtime::ActiveDialoguePredictionRoot>{*root}
                                       : std::nullopt;
    m_impl->active_dialogue_prediction.reset();
    if (root != nullptr && m_impl->package != nullptr) {
        runtime::FlowPredictor predictor(m_impl->package->project());
        m_impl->active_dialogue_prediction = predictor.predict(*root);
    }

    core::Diagnostics diagnostics;
    if (m_impl->active_dialogue_prediction)
        diagnostics = m_impl->active_dialogue_prediction->diagnostics;
    if (m_impl->group || m_impl->transaction_active || m_impl->package == nullptr ||
        !m_impl->dependency_index)
        return diagnostics;

    auto plan = m_impl->speculative_plan();
    core::append_diagnostics(diagnostics, std::move(plan.diagnostics));
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto previous_generation = m_impl->prefetch.active_generation_on_owner();
#endif
    auto submitted = m_impl->prefetch.replace_generation_on_owner(plan);
    if (!submitted) {
        diagnostics.push_back(std::move(submitted).error());
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    } else {
        m_impl->record_prefetch_replacement_on_owner(previous_generation, submitted.value(),
                                                     std::nullopt);
#endif
    }
    return diagnostics;
}

core::Diagnostics MandatoryAssetGate::update_resident_room_prediction_on_owner(
    const runtime::ResidentRoomPredictionRoot* root) noexcept
{
    const bool same_root = root != nullptr && m_impl->resident_root &&
                           *m_impl->resident_root == *root && !m_impl->active_scene_root &&
                           !m_impl->active_dialogue_root;
    const bool same_absence = root == nullptr && !m_impl->resident_root &&
                              !m_impl->active_scene_root && !m_impl->active_dialogue_root;
    if (same_root || same_absence)
        return {};

    m_impl->runtime_prediction_observed = true;
    m_impl->active_scene_root.reset();
    m_impl->active_scene_prediction.reset();
    m_impl->active_dialogue_root.reset();
    m_impl->active_dialogue_prediction.reset();
    m_impl->resident_root =
        root != nullptr ? std::optional<runtime::ResidentRoomPredictionRoot>{*root} : std::nullopt;
    m_impl->resident_prediction.reset();
    if (root != nullptr && m_impl->package != nullptr) {
        runtime::FlowPredictor predictor(m_impl->package->project());
        m_impl->resident_prediction = predictor.predict(*root);
    }

    core::Diagnostics diagnostics;
    if (m_impl->resident_prediction)
        diagnostics = m_impl->resident_prediction->diagnostics;
    if (m_impl->group || m_impl->transaction_active || m_impl->package == nullptr ||
        !m_impl->dependency_index)
        return diagnostics;

    auto plan = m_impl->speculative_plan();
    core::append_diagnostics(diagnostics, std::move(plan.diagnostics));
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto previous_generation = m_impl->prefetch.active_generation_on_owner();
#endif
    auto submitted = m_impl->prefetch.replace_generation_on_owner(plan);
    if (!submitted) {
        diagnostics.push_back(std::move(submitted).error());
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    } else {
        m_impl->record_prefetch_replacement_on_owner(previous_generation, submitted.value(),
                                                     std::nullopt);
#endif
    }
    return diagnostics;
}

std::optional<RuntimeMandatoryPublicationTransaction>
MandatoryAssetGate::take_ready_transaction_on_owner() noexcept
{
    if (!m_impl->group || m_impl->transaction_active)
        return std::nullopt;
    auto leases = m_impl->group->take_ready_leases_on_owner();
    if (!leases)
        return std::nullopt;
    auto transaction = m_impl->publication.begin_transaction_on_owner(
        std::move(*leases), m_impl->dependency_generation);
    m_impl->transaction_active = true;
    return RuntimeMandatoryPublicationTransaction(*this, std::move(transaction));
}

void MandatoryAssetGate::commit_ready_transaction_on_owner() noexcept
{
    if (!m_impl->transaction_active)
        return;
    m_impl->transaction_active = false;
    auto speculative_plan = m_impl->speculative_plan();
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    const auto previous_generation = m_impl->prefetch.active_generation_on_owner();
#endif
    auto submitted = m_impl->prefetch.replace_generation_on_owner(speculative_plan);
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (const auto* report = submitted.value_if())
        m_impl->record_prefetch_replacement_on_owner(previous_generation, *report,
                                                     m_impl->snapshot_revision);
#else
    (void)submitted;
#endif
    m_impl->group.reset();
    m_impl->snapshot_revision.reset();
    m_impl->pending_snapshot.reset();
}

void MandatoryAssetGate::abandon_ready_transaction_on_owner() noexcept
{
    if (m_impl == nullptr)
        return;
    m_impl->transaction_active = false;
    if (m_impl->group)
        m_impl->group->cancel_on_owner();
    m_impl->group.reset();
    m_impl->snapshot_revision.reset();
    m_impl->pending_snapshot.reset();
}

void MandatoryAssetGate::release_previous_publication_on_owner() noexcept
{
    m_impl->publication.release_predecessor_on_owner();
}

void MandatoryAssetGate::rollback_candidate_on_owner() noexcept
{
    if (m_impl == nullptr)
        return;
    if (m_impl->group)
        m_impl->group->cancel_on_owner();
    m_impl->publication.rollback_candidate_on_owner();
    m_impl->transaction_active = false;
    m_impl->group.reset();
    m_impl->snapshot_revision.reset();
    m_impl->pending_snapshot.reset();
}

void MandatoryAssetGate::cancel_on_owner() noexcept { rollback_candidate_on_owner(); }

void MandatoryAssetGate::show_overlay_immediately_on_owner() noexcept
{
    if (m_impl->group)
        m_impl->group->show_overlay_immediately_on_owner();
}

bool MandatoryAssetGate::active_on_owner() const noexcept { return m_impl->group.has_value(); }

bool MandatoryAssetGate::failed_on_owner() const noexcept
{
    return m_impl->group && m_impl->group->state_on_owner() == MandatoryAssetGroupState::Failed;
}

bool MandatoryAssetGate::overlay_visible_on_owner(
    MandatoryAssetRequestGroup::Clock::time_point now) const noexcept
{
    return m_impl->group && m_impl->group->overlay_visible_on_owner(now);
}

const core::LoadingProgress* MandatoryAssetGate::progress_on_owner() const noexcept
{
    return m_impl->group ? &m_impl->group->progress_on_owner() : nullptr;
}

std::optional<PrefetchGenerationId>
MandatoryAssetGate::active_prefetch_generation_on_owner() const noexcept
{
    return m_impl->prefetch.active_generation_on_owner();
}

} // namespace noveltea::assets
