#include "noveltea/assets/mandatory_asset_gate.hpp"

#include "noveltea/assets/asset_cache_keys.hpp"
#include "noveltea/assets/asset_manager.hpp"

#include <algorithm>
#include <atomic>
#include <limits>
#include <type_traits>
#include <utility>

namespace noveltea::assets {
namespace {

using StructuredAssetRequestHandle =
    std::variant<AssetRequestHandle<FontAsset>, AssetRequestHandle<TextureAsset>,
                 AssetRequestHandle<ShaderProgramAsset>, AssetRequestHandle<MaterialAsset>,
                 AssetRequestHandle<AudioAsset>>;

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

std::string logical_project_path(std::string_view path)
{
    if (path.starts_with("project:/") || path.starts_with("system:/"))
        return std::string(path);
    return "project:/" + std::string(path);
}

AudioClipKind audio_kind(core::compiled::AudioChannel channel) noexcept
{
    switch (channel) {
    case core::compiled::AudioChannel::SoundEffect:
        return AudioClipKind::Sfx;
    case core::compiled::AudioChannel::Music:
        return AudioClipKind::Music;
    case core::compiled::AudioChannel::Voice:
        return AudioClipKind::Voice;
    case core::compiled::AudioChannel::Ambient:
        return AudioClipKind::Ambience;
    }
    return AudioClipKind::Auto;
}

template<class T>
const AssetLease<T>* find_lease(const std::vector<StructuredAssetLeaseRecord>& records,
                                const AssetCacheKey& key) noexcept
{
    for (const auto& record : records) {
        if (record.descriptor.cache_key != key)
            continue;
        if (const auto* lease = std::get_if<AssetLease<T>>(&record.lease))
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

const AssetLease<TextureAsset>*
StructuredAssetLeaseSet::find_texture(const AssetCacheKey& key) const noexcept
{
    return find_lease<TextureAsset>(m_records, key);
}

const AssetLease<ShaderProgramAsset>*
StructuredAssetLeaseSet::find_shader_program(const AssetCacheKey& key) const noexcept
{
    return find_lease<ShaderProgramAsset>(m_records, key);
}

const AssetLease<MaterialAsset>*
StructuredAssetLeaseSet::find_material(const AssetCacheKey& key) const noexcept
{
    return find_lease<MaterialAsset>(m_records, key);
}

const AssetLease<AudioAsset>*
StructuredAssetLeaseSet::find_audio(const AssetCacheKey& key) const noexcept
{
    return find_lease<AudioAsset>(m_records, key);
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
        progress.retryable = options.retryable;
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

bool MandatoryAssetRequestGroup::retry_on_owner(Clock::time_point now) noexcept
{
    if (m_impl == nullptr || m_impl->state != MandatoryAssetGroupState::Failed ||
        !m_impl->options.retryable)
        return false;
    m_impl->leases_taken = false;
    m_impl->begin_on_owner(now);
    return true;
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

struct MandatoryAssetGate::Impl {
    explicit Impl(AssetManager& manager) noexcept : assets(manager), prefetch(manager) {}

    StructuredAssetDependencyContext
    context_for(const core::RuntimePresentationSnapshot& snapshot) const
    {
        StructuredAssetDependencyContext context;
        context.current_presentation = &snapshot;
        if (snapshot.mode != core::PresentationRuntimeMode::Ended)
            context.required_system_layouts.push_back(core::compiled::SystemLayoutRole::GameHud);
        if (package != nullptr && snapshot.current_room) {
            if (const auto* room = package->project().find_room(*snapshot.current_room)) {
                context.adjacent_alternatives.reserve(room->exits.size());
                for (const auto& exit : room->exits)
                    context.adjacent_alternatives.emplace_back(exit.target);
            }
        }
        return context;
    }

    AssetManager& assets;
    PrefetchPlanner prefetch;
    const core::LoadedCompiledPackage* package = nullptr;
    std::optional<StructuredAssetDependencyCollector> collector;
    std::optional<MandatoryAssetRequestGroup> group;
    StructuredAssetDependencyBuckets dependencies;
    std::optional<core::PresentationSnapshotRevision> snapshot_revision;
    bool candidate_active = false;
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

void MandatoryAssetGate::bind_package_on_owner(const core::LoadedCompiledPackage& package,
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
    m_impl->package = &package;
    m_impl->collector.emplace(
        StructuredAssetDependencyIndex::build(package, active_renderer_variant, generation));
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
    m_impl->collector.reset();
    m_impl->package = nullptr;
    m_impl->assets.clear_published_leases_on_owner();
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
    if (m_impl->group && m_impl->snapshot_revision == snapshot.revision)
        return gate_result(&*m_impl->group);

    rollback_candidate_on_owner();
    m_impl->dependencies = m_impl->collector->collect(m_impl->context_for(snapshot));
    if (!m_impl->dependencies.mandatory_diagnostics.empty()) {
        return {.disposition = MandatoryAssetGateDisposition::Failed,
                .diagnostics = m_impl->dependencies.mandatory_diagnostics};
    }
    m_impl->snapshot_revision = snapshot.revision;
    m_impl->group.emplace(
        m_impl->assets, m_impl->dependencies.current_mandatory,
        MandatoryAssetGroupOptions{.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                   .reason = AssetRequestReason::Demand,
                                   .overlay_grace = std::chrono::milliseconds{100},
                                   .show_overlay_immediately = false,
                                   .retryable = true,
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
    m_impl->group->poll_on_owner(now);
    return gate_result(&*m_impl->group);
}

core::Result<void, core::Diagnostics> MandatoryAssetGate::include_audio_operation_on_owner(
    const core::AudioOperation& operation,
    MandatoryAssetRequestGroup::Clock::time_point now) noexcept
{
    const bool starts_playback = operation.action == core::compiled::AudioAction::Play ||
                                 operation.action == core::compiled::AudioAction::FadeIn;
    if (!starts_playback || operation.purpose == core::AudioOperationPurpose::UiCosmetic)
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
                              .kind = audio_kind(operation.channel)};
    StructuredAssetRequestDescriptor descriptor{
        .request = request,
        .cache_key = make_audio_cache_key(request, m_impl->assets.source_generation_on_owner())};
    const auto duplicate =
        std::find_if(m_impl->dependencies.current_mandatory.begin(),
                     m_impl->dependencies.current_mandatory.end(), [&](const auto& current) {
                         return current.cache_key == descriptor.cache_key;
                     });
    if (duplicate != m_impl->dependencies.current_mandatory.end()) {
        m_impl->group->show_overlay_immediately_on_owner();
        return core::Result<void, core::Diagnostics>::success();
    }

    m_impl->dependencies.current_mandatory.push_back(std::move(descriptor));
    m_impl->group->cancel_on_owner();
    m_impl->group.emplace(
        m_impl->assets, m_impl->dependencies.current_mandatory,
        MandatoryAssetGroupOptions{.phase = core::LoadingPhase::LoadingRuntimeDemand,
                                   .reason = AssetRequestReason::Demand,
                                   .overlay_grace = std::chrono::milliseconds{100},
                                   .show_overlay_immediately = true,
                                   .retryable = true,
                                   .presentation_revision = m_impl->snapshot_revision},
        now);
    return core::Result<void, core::Diagnostics>::success();
}

bool MandatoryAssetGate::activate_candidate_on_owner() noexcept
{
    if (!m_impl->group || m_impl->candidate_active)
        return m_impl->candidate_active;
    auto leases = m_impl->group->take_ready_leases_on_owner();
    if (!leases)
        return false;
    m_impl->assets.stage_candidate_leases_on_owner(std::move(*leases));
    m_impl->candidate_active = true;
    return true;
}

void MandatoryAssetGate::commit_candidate_on_owner() noexcept
{
    if (!m_impl->candidate_active)
        return;
    m_impl->assets.commit_candidate_leases_on_owner();
    m_impl->candidate_active = false;
    auto submitted = m_impl->prefetch.replace_generation_on_owner(m_impl->dependencies);
#if NOVELTEA_ENABLE_EDITOR_ASSET_PROFILER
    if (const auto* report = submitted.value_if()) {
        if (auto* sink = m_impl->assets.asset_profiler_sink_on_owner()) {
            core::AssetProfilerPrefetchGenerationRecord record;
            record.generation = report->generation;
            record.presentation_revision = m_impl->snapshot_revision;
            record.expected_next_count = report->direct_next_count;
            record.possible_next_count = report->adjacent_count;
            for (const auto& entry : report->submitted_entries) {
                record.submitted_entries.push_back(
                    {.cache_key = entry.cache_key,
                     .prediction = entry.prediction == PrefetchPredictionKind::ExpectedNext
                                       ? core::PrefetchPredictionKind::ExpectedNext
                                       : core::PrefetchPredictionKind::PossibleNext});
            }
            for (const auto& failure : report->failures) {
                record.submission_failures.push_back(
                    {.cache_key = failure.cache_key,
                     .prediction = failure.prediction == PrefetchPredictionKind::ExpectedNext
                                       ? core::PrefetchPredictionKind::ExpectedNext
                                       : core::PrefetchPredictionKind::PossibleNext,
                     .diagnostic = failure.diagnostic});
            }
            sink->record_prefetch_generation(std::move(record));
        }
    }
#else
    (void)submitted;
#endif
    m_impl->group.reset();
    m_impl->snapshot_revision.reset();
}

void MandatoryAssetGate::rollback_candidate_on_owner() noexcept
{
    if (m_impl == nullptr)
        return;
    if (m_impl->group)
        m_impl->group->cancel_on_owner();
    m_impl->assets.rollback_candidate_leases_on_owner();
    m_impl->candidate_active = false;
    m_impl->group.reset();
    m_impl->snapshot_revision.reset();
}

bool MandatoryAssetGate::retry_on_owner(MandatoryAssetRequestGroup::Clock::time_point now) noexcept
{
    return m_impl->group && m_impl->group->retry_on_owner(now);
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
