#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"
#include "tooling_project_authority.hpp"

#include <noveltea/core/player_bootstrap.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <sddl.h>
#else
#include <cerrno>
#include <fcntl.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#include <poll.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace noveltea::tooling::daemon {
namespace {

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
using IoDeadline = std::optional<Clock::time_point>;

volatile std::sig_atomic_t client_interrupt_signal = 0;
std::mutex client_interrupt_mutex;
std::size_t client_interrupt_users = 0;
using SignalHandler = void (*)(int);
SignalHandler previous_sigint_handler = SIG_DFL;
SignalHandler previous_sigterm_handler = SIG_DFL;

void client_interrupt_handler(int signal_number) { client_interrupt_signal = signal_number; }

void acquire_client_interrupt_handler()
{
    std::scoped_lock lock(client_interrupt_mutex);
    if (client_interrupt_users++ == 0) {
        client_interrupt_signal = 0;
        previous_sigint_handler = std::signal(SIGINT, client_interrupt_handler);
        previous_sigterm_handler = std::signal(SIGTERM, client_interrupt_handler);
    }
}

void release_client_interrupt_handler()
{
    std::scoped_lock lock(client_interrupt_mutex);
    if (client_interrupt_users == 0)
        return;
    if (--client_interrupt_users == 0) {
        std::signal(SIGINT, previous_sigint_handler);
        std::signal(SIGTERM, previous_sigterm_handler);
        client_interrupt_signal = 0;
    }
}

class ClientInterruptScope {
public:
    explicit ClientInterruptScope(bool enabled) : enabled_(enabled)
    {
        if (!enabled_)
            return;
        acquire_client_interrupt_handler();
    }

    ~ClientInterruptScope()
    {
        if (!enabled_)
            return;
        release_client_interrupt_handler();
    }

    ClientInterruptScope(const ClientInterruptScope&) = delete;
    ClientInterruptScope& operator=(const ClientInterruptScope&) = delete;

    bool enabled() const { return enabled_; }

private:
    bool enabled_ = false;
};

std::mutex local_interrupt_scope_mutex;
bool local_interrupt_scope_active = false;

struct BrokerContext {
    std::string build;
    std::uint32_t protocol = protocol_version;
    std::uint64_t daemon_idle_ms = default_daemon_idle_ms;
    std::uint64_t project_session_idle_ms = default_project_session_idle_ms;
    std::uint64_t disposable_extra_idle_ms = 30'000;
    std::optional<std::filesystem::path> runtime_root_override;
    bool disposable_worker_processes_enabled = true;
};

struct Endpoint {
    std::string identity;
#if defined(_WIN32)
    std::wstring pipe_name;
    std::wstring startup_mutex_name;
    std::wstring lifetime_mutex_name;
#else
    std::filesystem::path runtime_root;
    std::filesystem::path socket_path;
    std::filesystem::path startup_lock_path;
    std::filesystem::path lifetime_lock_path;
#endif
};

std::optional<BrokerContext> parse_context(const Json& request, std::string& error)
{
    if (!request.contains("build") || !request["build"].is_string() ||
        request["build"].get_ref<const std::string&>().empty()) {
        error = "daemon request requires a non-empty build identity";
        return std::nullopt;
    }
    if (!request.contains("protocol") || !request["protocol"].is_number_unsigned()) {
        error = "daemon request requires an unsigned protocol version";
        return std::nullopt;
    }
    const auto protocol = request["protocol"].get<std::uint64_t>();
    if (protocol > UINT32_MAX) {
        error = "daemon protocol version is out of range";
        return std::nullopt;
    }
    BrokerContext context;
    context.build = request["build"].get<std::string>();
    context.protocol = static_cast<std::uint32_t>(protocol);
    if (request.contains("daemonIdleMs")) {
        if (!request["daemonIdleMs"].is_number_unsigned()) {
            error = "daemonIdleMs must be an unsigned integer";
            return std::nullopt;
        }
        context.daemon_idle_ms = request["daemonIdleMs"].get<std::uint64_t>();
    }
    if (request.contains("projectSessionIdleMs")) {
        if (!request["projectSessionIdleMs"].is_number_unsigned()) {
            error = "projectSessionIdleMs must be an unsigned integer";
            return std::nullopt;
        }
        context.project_session_idle_ms = request["projectSessionIdleMs"].get<std::uint64_t>();
    }
    if (request.contains("disposableExtraIdleMs")) {
        if (!request["disposableExtraIdleMs"].is_number_unsigned()) {
            error = "disposableExtraIdleMs must be an unsigned integer";
            return std::nullopt;
        }
        context.disposable_extra_idle_ms = request["disposableExtraIdleMs"].get<std::uint64_t>();
    }
    if (request.contains("runtimeRoot")) {
        if (!request["runtimeRoot"].is_string() ||
            request["runtimeRoot"].get_ref<const std::string&>().empty()) {
            error = "runtimeRoot must be a non-empty path";
            return std::nullopt;
        }
        context.runtime_root_override =
            std::filesystem::path(request["runtimeRoot"].get<std::string>());
    }
    if (request.contains("disableDisposableWorkerProcessesForTests")) {
        if (!request["disableDisposableWorkerProcessesForTests"].is_boolean()) {
            error = "disableDisposableWorkerProcessesForTests must be a boolean";
            return std::nullopt;
        }
        context.disposable_worker_processes_enabled =
            !request["disableDisposableWorkerProcessesForTests"].get<bool>();
    }
    if (context.daemon_idle_ms == 0 || context.project_session_idle_ms == 0) {
        error = "daemon idle intervals must be greater than zero";
        return std::nullopt;
    }
    return context;
}

std::string sha256_text(std::string_view text)
{
    return noveltea::core::sha256_hex(std::as_bytes(std::span(text.data(), text.size())));
}

#if defined(_WIN32)
std::wstring utf8_to_wide(std::string_view value)
{
    if (value.empty())
        return {};
    const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                             static_cast<int>(value.size()), nullptr, 0);
    if (required <= 0)
        throw std::runtime_error("failed to convert UTF-8 daemon path");
    std::wstring output(static_cast<std::size_t>(required), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), output.data(), required) != required)
        throw std::runtime_error("failed to convert UTF-8 daemon path");
    return output;
}

std::string wide_to_utf8(std::wstring_view value)
{
    if (value.empty())
        return {};
    const int required =
        WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0)
        throw std::runtime_error("failed to convert daemon executable path to UTF-8");
    std::string output(static_cast<std::size_t>(required), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), output.data(), required, nullptr,
                            nullptr) != required)
        throw std::runtime_error("failed to convert daemon executable path to UTF-8");
    return output;
}

std::optional<std::string> current_executable_path()
{
    std::wstring buffer(32768, L'\0');
    const auto size = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (size == 0 || size >= buffer.size())
        return std::nullopt;
    buffer.resize(size);
    return wide_to_utf8(buffer);
}

struct SecurityDescriptorOwner {
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    SecurityDescriptorOwner() = default;
    SecurityDescriptorOwner(const SecurityDescriptorOwner&) = delete;
    SecurityDescriptorOwner& operator=(const SecurityDescriptorOwner&) = delete;
    SecurityDescriptorOwner(SecurityDescriptorOwner&& other) noexcept
        : descriptor(std::exchange(other.descriptor, nullptr))
    {
    }
    SecurityDescriptorOwner& operator=(SecurityDescriptorOwner&& other) noexcept
    {
        if (this == &other)
            return *this;
        if (descriptor != nullptr)
            LocalFree(descriptor);
        descriptor = std::exchange(other.descriptor, nullptr);
        return *this;
    }
    ~SecurityDescriptorOwner()
    {
        if (descriptor != nullptr)
            LocalFree(descriptor);
    }
};

std::wstring current_user_sid_text()
{
    HANDLE token = nullptr;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token))
        throw std::runtime_error("failed to query current Windows user token");
    DWORD required = 0;
    GetTokenInformation(token, TokenUser, nullptr, 0, &required);
    std::vector<std::uint8_t> buffer(required);
    if (!GetTokenInformation(token, TokenUser, buffer.data(), required, &required)) {
        CloseHandle(token);
        throw std::runtime_error("failed to read current Windows user SID");
    }
    CloseHandle(token);
    const auto* user = reinterpret_cast<const TOKEN_USER*>(buffer.data());
    LPWSTR sid_text = nullptr;
    if (!ConvertSidToStringSidW(user->User.Sid, &sid_text))
        throw std::runtime_error("failed to format current Windows user SID");
    std::wstring result(sid_text);
    LocalFree(sid_text);
    return result;
}

SecurityDescriptorOwner current_user_security_descriptor()
{
    const auto sid_text = current_user_sid_text();
    const std::wstring sddl = L"D:P(A;;GA;;;" + sid_text + L")";
    SecurityDescriptorOwner owner;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
                                                              &owner.descriptor, nullptr))
        throw std::runtime_error("failed to construct daemon pipe security descriptor");
    return owner;
}
#else
void ensure_private_runtime_directory(const std::filesystem::path& directory)
{
    struct stat info {};
    if (::lstat(directory.c_str(), &info) != 0) {
        if (errno != ENOENT || ::mkdir(directory.c_str(), 0700) != 0)
            throw std::runtime_error("failed to create private daemon runtime directory");
        if (::lstat(directory.c_str(), &info) != 0)
            throw std::runtime_error("failed to inspect private daemon runtime directory");
    }
    if (!S_ISDIR(info.st_mode) || info.st_uid != geteuid())
        throw std::runtime_error("daemon runtime directory is not owned by the current user");
    if (::chmod(directory.c_str(), 0700) != 0)
        throw std::runtime_error("failed to restrict daemon runtime directory permissions");
    if (::lstat(directory.c_str(), &info) != 0 || !S_ISDIR(info.st_mode) ||
        info.st_uid != geteuid() || (info.st_mode & 0077) != 0)
        throw std::runtime_error("daemon runtime directory is not private to the current user");
}

std::filesystem::path production_runtime_root()
{
    if (const char* xdg = std::getenv("XDG_RUNTIME_DIR"); xdg != nullptr && *xdg != '\0') {
        const std::filesystem::path candidate(xdg);
        struct stat info {};
        if (::lstat(candidate.c_str(), &info) == 0 && S_ISDIR(info.st_mode) &&
            info.st_uid == geteuid() && (info.st_mode & 0022) == 0) {
            const auto nested = candidate / "noveltea";
            ensure_private_runtime_directory(nested);
            return nested;
        }
    }
    const auto fallback =
        std::filesystem::temp_directory_path() /
        ("noveltea-" + std::to_string(static_cast<unsigned long long>(geteuid())));
    ensure_private_runtime_directory(fallback);
    return fallback;
}

std::optional<std::string> current_executable_path()
{
#if defined(__APPLE__)
    std::uint32_t size = 0;
    (void)_NSGetExecutablePath(nullptr, &size);
    if (size == 0)
        return std::nullopt;
    std::string buffer(size, '\0');
    if (_NSGetExecutablePath(buffer.data(), &size) != 0)
        return std::nullopt;
    buffer.resize(std::strlen(buffer.c_str()));
    std::error_code error;
    const auto executable = std::filesystem::weakly_canonical(std::filesystem::path(buffer), error);
    if (error || executable.empty())
        return std::nullopt;
    return executable.string();
#else
    std::error_code error;
    const auto executable = std::filesystem::read_symlink("/proc/self/exe", error);
    if (error || executable.empty())
        return std::nullopt;
    return executable.string();
#endif
}
#endif

Endpoint make_endpoint(const BrokerContext& context)
{
    Endpoint endpoint;
    endpoint.identity = endpoint_identity(context.build, context.protocol);
#if defined(_WIN32)
    const auto sid = current_user_sid_text();
    const auto sid_utf8 = wide_to_utf8(sid);
    const auto user_identity = sha256_text(sid_utf8).substr(0, 16);
    const auto suffix = utf8_to_wide(endpoint.identity + "-" + user_identity);
    endpoint.pipe_name = L"\\\\.\\pipe\\NovelTea-" + suffix;
    endpoint.startup_mutex_name = L"Local\\NovelTea-Daemon-Start-" + suffix;
    endpoint.lifetime_mutex_name = L"Local\\NovelTea-Daemon-Live-" + suffix;
#else
    endpoint.runtime_root = context.runtime_root_override.value_or(production_runtime_root());
    ensure_private_runtime_directory(endpoint.runtime_root);
    endpoint.socket_path = endpoint.runtime_root / ("daemon-" + endpoint.identity + ".sock");
    endpoint.startup_lock_path =
        endpoint.runtime_root / ("daemon-" + endpoint.identity + ".start.lock");
    endpoint.lifetime_lock_path =
        endpoint.runtime_root / ("daemon-" + endpoint.identity + ".live.lock");
    if (endpoint.socket_path.string().size() >= sizeof(sockaddr_un::sun_path))
        throw std::runtime_error("daemon socket path exceeds Unix-domain socket path limit");
#endif
    return endpoint;
}

#if defined(_WIN32)
using ConnectionHandle = HANDLE;
const ConnectionHandle invalid_connection = INVALID_HANDLE_VALUE;
#else
using ConnectionHandle = int;
constexpr ConnectionHandle invalid_connection = -1;
#endif

void close_connection(ConnectionHandle connection)
{
#if defined(_WIN32)
    if (connection != invalid_connection) {
        FlushFileBuffers(connection);
        DisconnectNamedPipe(connection);
        CloseHandle(connection);
    }
#else
    if (connection != invalid_connection) {
        ::shutdown(connection, SHUT_RDWR);
        ::close(connection);
    }
#endif
}

void close_outbound_connection(ConnectionHandle connection)
{
#if defined(_WIN32)
    if (connection != invalid_connection) {
        CancelIoEx(connection, nullptr);
        CloseHandle(connection);
    }
#else
    close_connection(connection);
#endif
}

std::uint64_t remaining_millis(Clock::time_point deadline)
{
    const auto now = Clock::now();
    if (now >= deadline)
        return 0;
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    return static_cast<std::uint64_t>(std::max<std::int64_t>(1, remaining.count()));
}

#if defined(_WIN32)
DWORD remaining_windows_timeout(Clock::time_point deadline)
{
    constexpr auto maximum = static_cast<std::uint64_t>(INFINITE - 1);
    return static_cast<DWORD>(std::min(remaining_millis(deadline), maximum));
}

bool overlapped_transfer(ConnectionHandle connection, bool reading, std::uint8_t* bytes,
                         std::size_t size, std::size_t& transferred, Clock::time_point deadline)
{
    transferred = 0;
    if (remaining_millis(deadline) == 0)
        return false;
    OVERLAPPED operation{};
    operation.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (operation.hEvent == nullptr)
        return false;
    const auto chunk = static_cast<DWORD>(std::min<std::size_t>(size, 64 * 1024));
    DWORD immediate = 0;
    const BOOL started = reading ? ReadFile(connection, bytes, chunk, &immediate, &operation)
                                 : WriteFile(connection, bytes, chunk, &immediate, &operation);
    if (started) {
        transferred = immediate;
        CloseHandle(operation.hEvent);
        return immediate > 0;
    }
    if (GetLastError() != ERROR_IO_PENDING) {
        CloseHandle(operation.hEvent);
        return false;
    }
    const auto wait = WaitForSingleObject(operation.hEvent, remaining_windows_timeout(deadline));
    if (wait != WAIT_OBJECT_0) {
        CancelIoEx(connection, &operation);
        WaitForSingleObject(operation.hEvent, INFINITE);
        CloseHandle(operation.hEvent);
        return false;
    }
    DWORD completed = 0;
    const BOOL ok = GetOverlappedResult(connection, &operation, &completed, FALSE);
    CloseHandle(operation.hEvent);
    transferred = completed;
    return ok && completed > 0;
}
#else
bool wait_for_socket(ConnectionHandle connection, short events, Clock::time_point deadline)
{
    while (remaining_millis(deadline) > 0) {
        pollfd descriptor{connection, events, 0};
        const auto timeout = static_cast<int>(std::min<std::uint64_t>(
            remaining_millis(deadline), static_cast<std::uint64_t>(INT_MAX)));
        const auto result = ::poll(&descriptor, 1, timeout);
        if (result > 0)
            return (descriptor.revents & events) != 0 &&
                   (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) == 0;
        if (result == 0)
            return false;
        if (errno != EINTR)
            return false;
    }
    return false;
}
#endif

bool read_exact(ConnectionHandle connection, std::uint8_t* target, std::size_t size,
                IoDeadline deadline = std::nullopt)
{
    std::size_t offset = 0;
    while (offset < size) {
#if defined(_WIN32)
        if (deadline) {
            std::size_t read = 0;
            if (!overlapped_transfer(connection, true, target + offset, size - offset, read,
                                     *deadline))
                return false;
            offset += read;
            continue;
        }
        DWORD read = 0;
        const auto chunk = static_cast<DWORD>(std::min<std::size_t>(size - offset, 64 * 1024));
        if (!ReadFile(connection, target + offset, chunk, &read, nullptr) || read == 0)
            return false;
        offset += read;
#else
        if (deadline && !wait_for_socket(connection, POLLIN, *deadline))
            return false;
        const auto read =
            ::recv(connection, target + offset, size - offset, deadline ? MSG_DONTWAIT : 0);
        if (read <= 0) {
            if (read < 0 && errno == EINTR)
                continue;
            if (deadline && read < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
                continue;
            return false;
        }
        offset += static_cast<std::size_t>(read);
#endif
    }
    return true;
}

bool write_all(ConnectionHandle connection, std::span<const std::uint8_t> bytes,
               IoDeadline deadline = std::nullopt)
{
    std::size_t offset = 0;
    while (offset < bytes.size()) {
#if defined(_WIN32)
        if (deadline) {
            std::size_t written = 0;
            if (!overlapped_transfer(connection, false,
                                     const_cast<std::uint8_t*>(bytes.data()) + offset,
                                     bytes.size() - offset, written, *deadline))
                return false;
            offset += written;
            continue;
        }
        DWORD written = 0;
        const auto chunk =
            static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, 64 * 1024));
        if (!WriteFile(connection, bytes.data() + offset, chunk, &written, nullptr) || written == 0)
            return false;
        offset += written;
#else
        if (deadline && !wait_for_socket(connection, POLLOUT, *deadline))
            return false;
        const auto written = ::send(connection, bytes.data() + offset, bytes.size() - offset,
                                    MSG_NOSIGNAL | (deadline ? MSG_DONTWAIT : 0));
        if (written <= 0) {
            if (written < 0 && errno == EINTR)
                continue;
            if (deadline && written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
                continue;
            return false;
        }
        offset += static_cast<std::size_t>(written);
#endif
    }
    return true;
}

bool send_payload(ConnectionHandle connection, std::string_view payload,
                  IoDeadline deadline = std::nullopt)
{
    const auto frame = encode_frame(payload);
    return !frame.empty() && write_all(connection, frame, deadline);
}

std::optional<std::string> receive_payload(ConnectionHandle connection,
                                           IoDeadline deadline = std::nullopt)
{
    std::array<std::uint8_t, 4> header{};
    if (!read_exact(connection, header.data(), header.size(), deadline))
        return std::nullopt;
    const std::uint32_t length = (static_cast<std::uint32_t>(header[0]) << 24U) |
                                 (static_cast<std::uint32_t>(header[1]) << 16U) |
                                 (static_cast<std::uint32_t>(header[2]) << 8U) |
                                 static_cast<std::uint32_t>(header[3]);
    if (length == 0 || length > max_frame_bytes)
        return std::nullopt;
    std::string payload(length, '\0');
    if (!read_exact(connection, reinterpret_cast<std::uint8_t*>(payload.data()), payload.size(),
                    deadline))
        return std::nullopt;
    return payload;
}

struct ClientConnection {
    explicit ClientConnection(ConnectionHandle value) : handle(value) {}
    ~ClientConnection() { close(); }

    bool send(std::string_view payload)
    {
        std::scoped_lock lock(write_mutex);
        return handle != invalid_connection && send_payload(handle, payload);
    }

    void close()
    {
        std::scoped_lock lock(write_mutex);
        if (handle == invalid_connection)
            return;
        const auto previous = handle;
        handle = invalid_connection;
        close_connection(previous);
    }

    ConnectionHandle current() const
    {
        std::scoped_lock lock(write_mutex);
        return handle;
    }

    mutable std::mutex write_mutex;
    ConnectionHandle handle = invalid_connection;
};

struct QueuedRequest {
    std::weak_ptr<ClientConnection> client;
    std::string request_id;
    std::string method;
    Json payload = Json::object();
    bool prepare_disposable = false;
};

struct ActiveRequest {
    std::weak_ptr<ClientConnection> client;
    std::string request_id;
    bool cancelled = false;
    std::uint64_t cancellation_requested_millis = 0;
    std::optional<std::uint64_t> owner_worker_id;
    std::optional<std::uint64_t> disposable_worker_id;
    bool prepare_disposable = false;
    std::string pinned_project_root;
    std::optional<ProjectGenerationIdentity> pinned_generation;
    std::string method;
    Json payload = Json::object();
};

struct ChildProcess {
#if defined(_WIN32)
    HANDLE handle = nullptr;
    DWORD pid = 0;
#else
    pid_t pid = -1;
#endif
};

struct ProjectOwnerWorker {
    struct PendingSnapshot {
        ProjectGenerationIdentity identity;
        std::string owner_metadata;
        std::vector<std::string> chunks;
    };

    std::uint64_t id = 0;
    std::string canonical_root;
    std::uint64_t cold_session_epoch = 0;
    std::optional<std::uint64_t> retained_session_epoch;
    std::optional<std::uint64_t> active_session_epoch;
    std::optional<ProjectGenerationIdentity> active_generation;
    ChildProcess process;
    std::vector<QueuedRequest> queued;
    std::uint64_t last_activity_millis = 0;
    std::uint64_t critical_sections = 0;
    bool reconciling = false;
    bool dispatching = false;
    bool retiring = false;
    bool retirement_started = false;
    std::optional<PendingSnapshot> pending_snapshot;
};

struct ExactValidationResult {
    std::string canonical_root;
    std::string semantic_key;
    ProjectAuthorityCheckpoint authority;
    Json structured_result = Json::object();
    Json human_result = Json::array();
    Json json_result = Json::array();
    std::uint64_t revision = 0;
};

enum class DisposableWorkerState {
    starting,
    idle,
    busy,
    retiring
};

struct PreparedDisposableRequest {
    QueuedRequest request;
    std::string canonical_root;
    std::optional<ProjectGenerationIdentity> identity;
};

struct DisposableWorker {
    std::uint64_t id = 0;
    ChildProcess process;
    DisposableWorkerState state = DisposableWorkerState::starting;
    std::optional<PreparedDisposableRequest> assignment;
    std::uint64_t last_activity_millis = 0;
};

[[nodiscard]] std::optional<ChildProcess>
spawn_project_owner_process(const BrokerContext& context, std::uint64_t owner_worker_id);
[[nodiscard]] std::optional<ChildProcess>
spawn_disposable_worker_process(const BrokerContext& context, std::uint64_t worker_id);
[[nodiscard]] bool child_process_alive(const ChildProcess& process);
void terminate_child_process(ChildProcess& process);
void release_child_process(ChildProcess& process);

std::optional<ProjectAuthorityRequest> parse_project_authority_request(const Json& request,
                                                                       std::string& error);
Json project_observation_json(const ProjectObservation& observation);

class BrokerServer : public std::enable_shared_from_this<BrokerServer> {
public:
    BrokerServer(BrokerContext context, Endpoint endpoint)
        : context_(std::move(context)), endpoint_(std::move(endpoint))
    {
    }

    ~BrokerServer() { force_stop(); }

    Json start()
    {
        create_listener();
        state_.store(State::starting);
        listener_thread_ = std::thread([self = shared_from_this()] { self->listen_loop(); });
        idle_thread_ = std::thread([self = shared_from_this()] { self->idle_loop(); });
        return status_json();
    }

    Json mark_ready()
    {
        State expected = State::starting;
        if (!state_.compare_exchange_strong(expected, State::ready)) {
            if (state_.load() != State::ready)
                return error_json("daemon broker is not in starting state");
        }
        touch();
        {
            std::scoped_lock lock(queue_mutex_);
            ensure_disposable_standby_locked();
        }
        queue_cv_.notify_all();
        owner_cv_.notify_all();
        disposable_cv_.notify_all();
        return status_json();
    }

    Json take_next_request()
    {
        for (;;) {
            QueuedRequest queued;
            {
                std::unique_lock lock(queue_mutex_);
                queue_cv_.wait(lock, [this] {
                    return !queued_.empty() || state_.load() == State::draining ||
                           state_.load() == State::stopped;
                });
                if (queued_.empty())
                    return {{"ok", true}, {"stopped", true}};
                queued = std::move(queued_.front());
                queued_.erase(queued_.begin());
            }
            const auto client = queued.client.lock();
            if (!client || client->current() == invalid_connection)
                continue;
            const auto token = next_request_token_.fetch_add(1);
            {
                std::scoped_lock lock(queue_mutex_);
                active_.emplace(token, ActiveRequest{
                                           .client = client,
                                           .request_id = queued.request_id,
                                           .cancelled = false,
                                           .cancellation_requested_millis = 0,
                                           .owner_worker_id = std::nullopt,
                                           .disposable_worker_id = std::nullopt,
                                           .prepare_disposable = false,
                                           .pinned_project_root = {},
                                           .pinned_generation = std::nullopt,
                                           .method = queued.method,
                                           .payload = queued.payload,
                                       });
            }
            touch();
            return {{"ok", true},
                    {"stopped", false},
                    {"token", token},
                    {"requestId", queued.request_id},
                    {"method", queued.method},
                    {"payload", std::move(queued.payload)}};
        }
    }

    Json take_owner_request(std::uint64_t owner_worker_id)
    {
        for (;;) {
            QueuedRequest queued;
            {
                std::unique_lock lock(queue_mutex_);
                const bool awakened = owner_cv_.wait_for(
                    lock, std::chrono::milliseconds(200), [this, owner_worker_id] {
                        const auto found = project_owners_.find(owner_worker_id);
                        return state_.load() == State::draining ||
                               state_.load() == State::stopped || found == project_owners_.end() ||
                               found->second.retiring ||
                               (state_.load() == State::ready &&
                                !exact_validation_probe_roots_.contains(
                                    found->second.canonical_root) &&
                                !found->second.queued.empty());
                    });
                const auto found = project_owners_.find(owner_worker_id);
                if (state_.load() == State::draining || state_.load() == State::stopped ||
                    found == project_owners_.end() || found->second.retiring)
                    return {{"ok", true}, {"stopped", true}};
                if (!awakened &&
                    exact_validation_probe_roots_.contains(found->second.canonical_root))
                    continue;
                if (!awakened)
                    return {{"ok", true}, {"stopped", false}, {"idle", true}};
                if (found->second.queued.empty())
                    continue;
                // Foreground owner-bound reads/mutations outrank disposable-heavy preparation.
                // Heavy jobs only need a short exact-generation preparation pass on the owner;
                // their expensive execution occurs elsewhere.
                auto selected = std::find_if(
                    found->second.queued.begin(), found->second.queued.end(),
                    [](const QueuedRequest& request) { return !request.prepare_disposable; });
                if (selected == found->second.queued.end())
                    selected = found->second.queued.begin();
                queued = std::move(*selected);
                found->second.queued.erase(selected);
                found->second.dispatching = true;
                found->second.last_activity_millis = now_millis();
            }
            const auto client = queued.client.lock();
            if (!client || client->current() == invalid_connection) {
                std::scoped_lock lock(queue_mutex_);
                const auto owner = project_owners_.find(owner_worker_id);
                if (owner != project_owners_.end())
                    owner->second.dispatching = false;
                owner_cv_.notify_all();
                continue;
            }
            const auto token = next_request_token_.fetch_add(1);
            {
                std::scoped_lock lock(queue_mutex_);
                const auto owner = project_owners_.find(owner_worker_id);
                if (owner == project_owners_.end() || owner->second.retiring)
                    continue;
                active_.emplace(token, ActiveRequest{
                                           .client = client,
                                           .request_id = queued.request_id,
                                           .cancelled = false,
                                           .cancellation_requested_millis = 0,
                                           .owner_worker_id = owner_worker_id,
                                           .disposable_worker_id = std::nullopt,
                                           .prepare_disposable = queued.prepare_disposable,
                                           .pinned_project_root = {},
                                           .pinned_generation = std::nullopt,
                                           .method = queued.method,
                                           .payload = queued.payload,
                                       });
                owner->second.dispatching = false;
                owner->second.last_activity_millis = now_millis();
            }
            touch();
            return {{"ok", true},
                    {"stopped", false},
                    {"token", token},
                    {"requestId", queued.request_id},
                    {"method", queued.method},
                    {"prepareDisposable", queued.prepare_disposable},
                    {"payload", std::move(queued.payload)}};
        }
    }

    Json complete_owner_request(std::uint64_t owner_worker_id, std::uint64_t token, bool ok,
                                const Json& result, std::string_view error)
    {
        ActiveRequest active;
        std::string canonical_root;
        std::optional<ProjectGenerationIdentity> active_generation;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found = active_.find(token);
            if (found == active_.end() || found->second.owner_worker_id != owner_worker_id)
                return error_json(
                    "daemon Project-owner request token is not active for this worker");
            active = found->second;
            if (active.prepare_disposable) {
                const auto owner = project_owners_.find(owner_worker_id);
                if (owner != project_owners_.end() && !owner->second.retiring) {
                    canonical_root = owner->second.canonical_root;
                    active_generation = owner->second.active_generation;
                }
            }
        }
        if (active.prepare_disposable) {
            if (active.cancelled)
                return complete_request(token, false, Json(), "request cancelled");
            if (!ok)
                return complete_request(token, false, result, error);
            if (canonical_root.empty() || !active_generation)
                return complete_request(
                    token, false, Json(),
                    "Project owner did not publish a generation for disposable work");
            if (!project_snapshots_.pin_current(canonical_root, *active_generation, now_millis()))
                return complete_request(
                    token, false, Json(),
                    "Project owner did not publish the requested portable snapshot");
            {
                std::scoped_lock lock(queue_mutex_);
                const auto found = active_.find(token);
                if (found == active_.end()) {
                    (void)project_snapshots_.unpin(canonical_root, *active_generation,
                                                   now_millis());
                    return error_json("daemon disposable preparation token is no longer active");
                }
                active_.erase(found);
                prepared_disposable_.push_back(PreparedDisposableRequest{
                    .request = QueuedRequest{active.client, active.request_id, active.method,
                                             active.payload, false},
                    .canonical_root = canonical_root,
                    .identity = *active_generation,
                });
                disposable_queues_.fetch_add(1);
                snapshot_handoffs_.fetch_add(1);
                assign_disposable_jobs_locked();
            }
            touch_owner(owner_worker_id);
            touch();
            active_cv_.notify_all();
            disposable_cv_.notify_all();
            return {{"ok", true}, {"delivered", false}, {"queuedDisposable", true}};
        }
        auto completed = complete_request(token, ok, result, error);
        if (completed.value("ok", false))
            touch_owner(owner_worker_id);
        return completed;
    }

    Json retain_owner_validation_result(std::uint64_t owner_worker_id, std::uint64_t token,
                                        std::string semantic_key, Json structured_result,
                                        Json human_result, Json json_result)
    {
        std::string canonical_root;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto active = active_.find(token);
            const auto owner = project_owners_.find(owner_worker_id);
            if (active == active_.end() || active->second.owner_worker_id != owner_worker_id ||
                owner == project_owners_.end() || owner->second.retiring)
                return error_json(
                    "exact validation result does not belong to an active owner request");
            const auto& payload = active->second.payload;
            if (!payload.is_object() ||
                payload.value("authoringValidationSemanticKey", std::string{}) != semantic_key ||
                !payload.contains("argv") || !payload["argv"].is_array() ||
                std::find(payload["argv"].begin(), payload["argv"].end(), "validate") ==
                    payload["argv"].end())
                return error_json(
                    "exact validation result does not match the active validate request");
            canonical_root = owner->second.canonical_root;
        }
        if (!structured_result.is_object() || !structured_result.contains("success") ||
            !structured_result["success"].is_boolean() || !structured_result.contains("exitCode") ||
            !structured_result["exitCode"].is_number_integer() ||
            !structured_result.contains("diagnostics") ||
            !structured_result["diagnostics"].is_array() ||
            !structured_result.contains("editorDiagnostics") ||
            !structured_result["editorDiagnostics"].is_array() || !human_result.is_array() ||
            human_result.size() != 3 || !json_result.is_array() || json_result.size() != 3)
            return error_json("exact validation result payload is malformed");

#if defined(_WIN32)
        const std::filesystem::path root = utf8_to_wide(canonical_root);
#else
        const std::filesystem::path root = canonical_root;
#endif
        const auto checkpoint = project_authority_.checkpoint(root);
        if (!checkpoint)
            return error_json("exact validation result has no proven native Project authority");

        ExactValidationResult retained{
            .canonical_root = canonical_root,
            .semantic_key = std::move(semantic_key),
            .authority = *checkpoint,
            .structured_result = std::move(structured_result),
            .human_result = std::move(human_result),
            .json_result = std::move(json_result),
            .revision = next_validation_revision_.fetch_add(1),
        };
        {
            std::scoped_lock lock(validation_mutex_);
            exact_validation_results_[canonical_root] = retained;
            pending_validation_publications_[canonical_root] = std::move(retained);
        }
        return {{"ok", true}};
    }

    Json emit_owner_request_event(std::uint64_t owner_worker_id, std::uint64_t token,
                                  const Json& event)
    {
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found = active_.find(token);
            if (found == active_.end() || found->second.owner_worker_id != owner_worker_id)
                return error_json("daemon Project-owner event token is not active for this worker");
        }
        return emit_request_event(token, event);
    }

    Json owner_cancellation_status(std::uint64_t owner_worker_id, std::uint64_t token)
    {
        std::scoped_lock lock(queue_mutex_);
        const auto found = active_.find(token);
        if (found == active_.end() || found->second.owner_worker_id != owner_worker_id)
            return {{"ok", true}, {"active", false}, {"cancelled", true}};
        return {{"ok", true}, {"active", true}, {"cancelled", found->second.cancelled}};
    }

    Json mark_disposable_ready(std::uint64_t worker_id)
    {
        std::scoped_lock lock(queue_mutex_);
        const auto worker = disposable_workers_.find(worker_id);
        if (worker == disposable_workers_.end() ||
            worker->second.state == DisposableWorkerState::retiring)
            return error_json("daemon disposable worker is unavailable");
        if (worker->second.state == DisposableWorkerState::starting)
            worker->second.state = DisposableWorkerState::idle;
        worker->second.last_activity_millis = now_millis();
        assign_disposable_jobs_locked();
        ensure_disposable_standby_locked();
        disposable_cv_.notify_all();
        return {{"ok", true}};
    }

    Json take_disposable_request(std::uint64_t worker_id)
    {
        std::unique_lock lock(queue_mutex_);
        disposable_cv_.wait(lock, [this, worker_id] {
            const auto worker = disposable_workers_.find(worker_id);
            return state_.load() == State::draining || state_.load() == State::stopped ||
                   worker == disposable_workers_.end() ||
                   worker->second.state == DisposableWorkerState::retiring ||
                   worker->second.assignment.has_value();
        });
        const auto worker = disposable_workers_.find(worker_id);
        if (state_.load() == State::draining || state_.load() == State::stopped ||
            worker == disposable_workers_.end() ||
            worker->second.state == DisposableWorkerState::retiring)
            return {{"ok", true}, {"stopped", true}};
        if (!worker->second.assignment)
            return error_json("daemon disposable worker has no assignment");
        auto assignment = std::move(*worker->second.assignment);
        worker->second.assignment.reset();
        const auto client = assignment.request.client.lock();
        if (!client || client->current() == invalid_connection) {
            if (assignment.identity)
                (void)project_snapshots_.unpin(assignment.canonical_root, *assignment.identity,
                                               now_millis());
            worker->second.state = DisposableWorkerState::retiring;
            disposable_cv_.notify_all();
            return {{"ok", true}, {"stopped", true}};
        }
        const auto token = next_request_token_.fetch_add(1);
        active_.emplace(token, ActiveRequest{
                                   .client = client,
                                   .request_id = assignment.request.request_id,
                                   .cancelled = false,
                                   .cancellation_requested_millis = 0,
                                   .owner_worker_id = std::nullopt,
                                   .disposable_worker_id = worker_id,
                                   .prepare_disposable = false,
                                   .pinned_project_root = assignment.canonical_root,
                                   .pinned_generation = assignment.identity,
                                   .method = assignment.request.method,
                                   .payload = assignment.request.payload,
                               });
        worker->second.last_activity_millis = now_millis();
        touch();
        Json result{{"ok", true},
                    {"stopped", false},
                    {"token", token},
                    {"requestId", assignment.request.request_id},
                    {"method", assignment.request.method},
                    {"payload", std::move(assignment.request.payload)},
                    {"hasProjectSnapshot", assignment.identity.has_value()}};
        if (!assignment.identity)
            return result;
        const auto snapshot =
            project_snapshots_.find(assignment.canonical_root, *assignment.identity, now_millis());
        if (!snapshot) {
            active_.erase(token);
            (void)project_snapshots_.unpin(assignment.canonical_root, *assignment.identity,
                                           now_millis());
            worker->second.state = DisposableWorkerState::retiring;
            return error_json("pinned portable Project snapshot is unavailable");
        }
        result["canonicalRoot"] = assignment.canonical_root;
        result["sessionEpoch"] = assignment.identity->session_epoch;
        result["generation"] = assignment.identity->generation;
        result["chunkCount"] = snapshot->chunk_count;
        result["ownerMetadata"] = snapshot->opaque_owner_metadata;
        return result;
    }

    Json read_disposable_snapshot_chunk(std::uint64_t worker_id, std::uint64_t token,
                                        std::size_t index)
    {
        std::string root;
        ProjectGenerationIdentity identity;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto active = active_.find(token);
            if (active == active_.end() || active->second.disposable_worker_id != worker_id ||
                !active->second.pinned_generation || active->second.pinned_project_root.empty())
                return error_json("daemon disposable snapshot token is not active");
            root = active->second.pinned_project_root;
            identity = *active->second.pinned_generation;
        }
        const auto chunk = project_snapshots_.chunk(root, identity, index, now_millis());
        if (!chunk)
            return error_json("daemon disposable snapshot chunk is unavailable");
        return {{"ok", true}, {"chunk", *chunk}};
    }

    Json disposable_cancellation_status(std::uint64_t worker_id, std::uint64_t token)
    {
        std::scoped_lock lock(queue_mutex_);
        const auto active = active_.find(token);
        if (active == active_.end() || active->second.disposable_worker_id != worker_id)
            return {{"ok", true}, {"active", false}, {"cancelled", true}};
        return {{"ok", true}, {"active", true}, {"cancelled", active->second.cancelled}};
    }

    Json emit_disposable_request_event(std::uint64_t worker_id, std::uint64_t token,
                                       const Json& event)
    {
        {
            std::scoped_lock lock(queue_mutex_);
            const auto active = active_.find(token);
            if (active == active_.end() || active->second.disposable_worker_id != worker_id)
                return error_json("daemon disposable event token is not active for this worker");
        }
        return emit_request_event(token, event);
    }

    Json complete_disposable_request(std::uint64_t worker_id, std::uint64_t token, bool ok,
                                     const Json& result, std::string_view error)
    {
        std::string root;
        std::optional<ProjectGenerationIdentity> identity;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto active = active_.find(token);
            if (active == active_.end() || active->second.disposable_worker_id != worker_id)
                return error_json("daemon disposable request token is not active for this worker");
            root = active->second.pinned_project_root;
            identity = active->second.pinned_generation;
        }
        auto completed = complete_request(token, ok, result, error);
        if (identity)
            (void)project_snapshots_.unpin(root, *identity, now_millis());
        {
            std::scoped_lock lock(queue_mutex_);
            const auto worker = disposable_workers_.find(worker_id);
            if (worker != disposable_workers_.end())
                worker->second.state = DisposableWorkerState::retiring;
            ensure_disposable_standby_locked();
        }
        disposable_cv_.notify_all();
        return completed;
    }

    Json owner_reconciliation_status(std::uint64_t owner_worker_id)
    {
        std::string root;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring)
                return {{"ok", false}, {"error", "daemon Project owner is not active"}};
            if (owner->second.reconciling)
                return {{"ok", false}, {"error", "daemon Project owner is already reconciling"}};
            owner->second.reconciling = true;
            root = owner->second.canonical_root;
        }
#if defined(_WIN32)
        const std::filesystem::path project_root = utf8_to_wide(root);
#else
        const std::filesystem::path project_root = root;
#endif
        std::optional<ProjectAuthorityStatus> status;
        try {
            status = project_authority_.status(project_root);
        } catch (...) {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner != project_owners_.end())
                owner->second.reconciling = false;
            owner_cv_.notify_all();
            throw;
        }
        const bool needed = status && (status->state == ProjectAuthorityState::dirty ||
                                       status->state == ProjectAuthorityState::unknown);
        if (!needed) {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner != project_owners_.end())
                owner->second.reconciling = false;
            owner_cv_.notify_all();
        }
        return {{"ok", true}, {"needsReconcile", needed}};
    }

    Json complete_owner_reconciliation(std::uint64_t owner_worker_id, bool advanced)
    {
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || !owner->second.reconciling)
                return error_json("daemon Project owner is not reconciling");
            owner->second.reconciling = false;
            if (advanced && !owner->second.retiring)
                owner->second.last_activity_millis = now_millis();
        }
        owner_cv_.notify_all();
        if (advanced)
            touch();
        return {{"ok", true}};
    }

    Json complete_request(std::uint64_t token, bool ok, const Json& result, std::string_view error)
    {
        ActiveRequest active;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found = active_.find(token);
            if (found == active_.end())
                return error_json("daemon request token is not active");
            active = found->second;
        }
        bool delivered = false;
        const auto client = active.client.lock();
        if (client && client->current() != invalid_connection) {
            const auto result_text = result.dump();
            delivered = client->send(result_event_json(active.request_id, ok, result_text, error));
        }
        {
            std::scoped_lock lock(queue_mutex_);
            active_.erase(token);
        }
        touch();
        active_cv_.notify_all();
        return {{"ok", true}, {"delivered", delivered}};
    }

    Json emit_request_event(std::uint64_t token, const Json& event)
    {
        ActiveRequest active;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found = active_.find(token);
            if (found == active_.end())
                return error_json("daemon request token is not active");
            active = found->second;
        }
        const auto client = active.client.lock();
        if (!client || client->current() == invalid_connection)
            return {{"ok", true}, {"delivered", false}};
        const auto type = event.value("type", std::string{});
        std::string payload;
        if (type == "stdout" || type == "stderr") {
            if (!event.contains("text") || !event["text"].is_string())
                return error_json("daemon text event requires text");
            payload = text_event_json(type, active.request_id, event["text"].get<std::string>());
        } else if (type == "progress") {
            if (!event.contains("message") || !event["message"].is_string())
                return error_json("daemon progress event requires message");
            payload = progress_event_json(active.request_id, event["message"].get<std::string>(),
                                          event.value("completed", std::uint64_t{0}),
                                          event.value("total", std::uint64_t{0}));
        } else {
            return error_json("unsupported daemon event type");
        }
        return {{"ok", true}, {"delivered", client->send(payload)}};
    }

    Json cancellation_status(std::uint64_t token)
    {
        std::scoped_lock lock(queue_mutex_);
        const auto found = active_.find(token);
        if (found == active_.end())
            return {{"ok", true}, {"active", false}, {"cancelled", true}};
        return {{"ok", true}, {"active", true}, {"cancelled", found->second.cancelled}};
    }

    Json enter_critical_section()
    {
        std::scoped_lock lock(critical_mutex_);
        if (state_.load() == State::draining || state_.load() == State::stopped)
            return error_json("daemon broker is draining");
        critical_sections_.fetch_add(1);
        return status_json();
    }

    Json leave_critical_section()
    {
        {
            std::scoped_lock lock(critical_mutex_);
            const auto previous = critical_sections_.load();
            if (previous == 0)
                return error_json("daemon critical-section count is already zero");
            critical_sections_.fetch_sub(1);
        }
        critical_cv_.notify_all();
        return status_json();
    }

    Json enter_owner_critical_section(std::uint64_t owner_worker_id)
    {
        {
            std::scoped_lock critical_lock(critical_mutex_);
            if (state_.load() == State::draining || state_.load() == State::stopped)
                return error_json("daemon broker is draining");
            std::scoped_lock queue_lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring)
                return error_json("daemon Project owner is not active");
            owner->second.critical_sections += 1;
            critical_sections_.fetch_add(1);
        }
        return status_json();
    }

    Json leave_owner_critical_section(std::uint64_t owner_worker_id)
    {
        {
            std::scoped_lock critical_lock(critical_mutex_);
            std::scoped_lock queue_lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring)
                return error_json("daemon Project owner is not active");
            if (owner->second.critical_sections == 0)
                return error_json("daemon Project-owner critical-section count is already zero");
            owner->second.critical_sections -= 1;
            critical_sections_.fetch_sub(1);
        }
        critical_cv_.notify_all();
        return status_json();
    }

    Json set_project_session_count(std::uint64_t count)
    {
        generic_project_sessions_.store(count);
        return status_json();
    }

    ProjectObservation observe_project(const ProjectAuthorityRequest& request)
    {
        auto observation = project_authority_.observe(request);
        record_authority_observation(observation);
        return observation;
    }

    ProjectObservation observe_owner_project(std::uint64_t owner_worker_id,
                                             const ProjectAuthorityRequest& request)
    {
#if defined(_WIN32)
        const auto requested_root =
            canonical_project_owner_root(wide_to_utf8(request.project_root.wstring()), false);
#else
        const auto requested_root =
            canonical_project_owner_root(request.project_root.string(), false);
#endif
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring ||
                owner->second.canonical_root != requested_root)
                throw std::runtime_error(
                    "Project authority request does not belong to this owner worker");
        }
        auto observation = project_authority_.observe(request);
        record_authority_observation(observation);
        if (!observation.delta.added.empty() || !observation.delta.changed.empty() ||
            !observation.delta.removed.empty())
            touch_owner(owner_worker_id);
        return observation;
    }

    bool release_project(const std::filesystem::path& project_root)
    {
        return project_authority_.release(project_root);
    }

    bool release_owner_project(std::uint64_t owner_worker_id,
                               const std::filesystem::path& project_root)
    {
#if defined(_WIN32)
        const auto requested_root =
            canonical_project_owner_root(wide_to_utf8(project_root.wstring()), false);
#else
        const auto requested_root = canonical_project_owner_root(project_root.string(), false);
#endif
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.canonical_root != requested_root)
                return false;
        }
        return project_authority_.release(project_root);
    }

    Json declare_owner_generation(std::uint64_t owner_worker_id, ProjectGenerationIdentity identity)
    {
        if (identity.session_epoch == 0 || identity.generation == 0)
            return error_json("resident Project generation identity is invalid");
        std::scoped_lock lock(queue_mutex_);
        const auto owner = project_owners_.find(owner_worker_id);
        if (owner == project_owners_.end() || owner->second.retiring)
            return error_json("resident Project generation owner is unavailable");
        if (owner->second.active_generation) {
            const auto active = *owner->second.active_generation;
            if (active.session_epoch != identity.session_epoch ||
                active.generation > identity.generation)
                return error_json("resident Project generation regressed or changed session epoch");
        } else if (identity.session_epoch != owner->second.cold_session_epoch &&
                   (!owner->second.retained_session_epoch ||
                    identity.session_epoch != *owner->second.retained_session_epoch)) {
            return error_json("resident Project generation session epoch does not belong to owner");
        }
        if (!project_snapshots_.declare_current(owner->second.canonical_root, identity,
                                                now_millis()))
            return error_json("resident Project generation could not be declared current");
        owner->second.active_session_epoch = identity.session_epoch;
        owner->second.active_generation = identity;
        generation_promotions_.fetch_add(1);
        return {{"ok", true}};
    }

    Json begin_owner_snapshot(std::uint64_t owner_worker_id, ProjectGenerationIdentity identity,
                              std::string owner_metadata)
    {
        if (identity.session_epoch == 0 || identity.generation == 0)
            return error_json("portable Project snapshot identity is invalid");
        if (owner_metadata.size() > 256 * 1024)
            return error_json("portable Project owner metadata is too large");
        std::scoped_lock lock(queue_mutex_);
        const auto owner = project_owners_.find(owner_worker_id);
        if (owner == project_owners_.end() || owner->second.retiring)
            return error_json("portable Project snapshot owner is unavailable");
        if (!owner->second.active_generation || *owner->second.active_generation != identity)
            return error_json("portable Project snapshot is not the owner's current generation");
        owner->second.pending_snapshot = ProjectOwnerWorker::PendingSnapshot{
            .identity = identity,
            .owner_metadata = std::move(owner_metadata),
            .chunks = {},
        };
        return {{"ok", true}};
    }

    Json append_owner_snapshot_chunk(std::uint64_t owner_worker_id, std::string chunk)
    {
        if (chunk.empty() || chunk.size() > 192 * 1024)
            return error_json("portable Project snapshot chunk is invalid");
        std::scoped_lock lock(queue_mutex_);
        const auto owner = project_owners_.find(owner_worker_id);
        if (owner == project_owners_.end() || owner->second.retiring ||
            !owner->second.pending_snapshot)
            return error_json("portable Project snapshot upload is not active");
        owner->second.pending_snapshot->chunks.push_back(std::move(chunk));
        return {{"ok", true}, {"chunkCount", owner->second.pending_snapshot->chunks.size()}};
    }

    Json commit_owner_snapshot(std::uint64_t owner_worker_id)
    {
        std::string canonical_root;
        ProjectOwnerWorker::PendingSnapshot pending;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring ||
                !owner->second.pending_snapshot)
                return error_json("portable Project snapshot upload is not active");
            canonical_root = owner->second.canonical_root;
            pending = std::move(*owner->second.pending_snapshot);
            owner->second.pending_snapshot.reset();
        }
        if (pending.chunks.empty())
            return error_json("portable Project snapshot upload is empty");
#if defined(_WIN32)
        const std::filesystem::path project_root = utf8_to_wide(canonical_root);
#else
        const std::filesystem::path project_root = canonical_root;
#endif
        const auto authority_checkpoint = project_authority_.checkpoint(project_root);
        if (!authority_checkpoint)
            return error_json(
                "portable Project snapshot has no proven native authority checkpoint");
        if (!project_snapshots_.publish(
                std::move(canonical_root), pending.identity, std::move(pending.chunks),
                std::move(pending.owner_metadata), *authority_checkpoint, now_millis()))
            return error_json("portable Project snapshot was rejected as stale");
        snapshot_publications_.fetch_add(1);
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner != project_owners_.end() && !owner->second.retiring)
                owner->second.active_session_epoch = pending.identity.session_epoch;
        }
        return {{"ok", true},
                {"snapshotCount", project_snapshots_.snapshot_count()},
                {"snapshotBytes", project_snapshots_.retained_bytes()}};
    }

    Json describe_owner_snapshot(std::uint64_t owner_worker_id)
    {
        std::string canonical_root;
        std::uint64_t cold_session_epoch = 0;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring)
                return error_json("portable Project snapshot owner is unavailable");
            canonical_root = owner->second.canonical_root;
            cold_session_epoch = owner->second.cold_session_epoch;
        }
        const auto snapshot = project_snapshots_.latest(canonical_root, now_millis());
        if (!snapshot)
            return {{"ok", true},
                    {"found", false},
                    {"canonicalRoot", canonical_root},
                    {"coldSessionEpoch", cold_session_epoch}};
        return {{"ok", true},
                {"found", true},
                {"canonicalRoot", canonical_root},
                {"coldSessionEpoch", cold_session_epoch},
                {"sessionEpoch", snapshot->identity.session_epoch},
                {"generation", snapshot->identity.generation},
                {"chunkCount", snapshot->chunk_count},
                {"ownerMetadata", snapshot->opaque_owner_metadata}};
    }

    Json read_owner_snapshot_chunk(std::uint64_t owner_worker_id,
                                   ProjectGenerationIdentity identity, std::size_t index)
    {
        std::string canonical_root;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto owner = project_owners_.find(owner_worker_id);
            if (owner == project_owners_.end() || owner->second.retiring)
                return error_json("portable Project snapshot owner is unavailable");
            canonical_root = owner->second.canonical_root;
        }
        const auto chunk = project_snapshots_.chunk(canonical_root, identity, index, now_millis());
        if (!chunk)
            return error_json("portable Project snapshot chunk is unavailable");
        return {{"ok", true}, {"chunk", *chunk}};
    }

    Json wait()
    {
        {
            std::unique_lock lock(state_mutex_);
            state_cv_.wait(lock, [this] { return state_.load() == State::stopped; });
        }
        join_threads();
        return status_json();
    }

    void force_stop()
    {
        const auto state = state_.exchange(State::stopped);
        if (state == State::stopped)
            return;
        cancel_queued("daemon is stopping");
        retire_all_disposable_workers("daemon is stopping");
        retire_all_project_owners("daemon is stopping");
        stop_accepting();
#if !defined(_WIN32)
        std::error_code error;
        std::filesystem::remove(endpoint_.socket_path, error);
#endif
        release_lifetime_ownership();
        close_clients();
        state_cv_.notify_all();
        active_cv_.notify_all();
        critical_cv_.notify_all();
        join_threads();
    }

    Json status_json() const
    {
        Json result = {{"ok", true},
                       {"running", state_.load() != State::stopped},
                       {"state", state_name(state_.load())},
                       {"build", context_.build},
                       {"protocol", context_.protocol},
                       {"pid", current_pid()},
                       {"projectSessionIdleMs", context_.project_session_idle_ms},
                       {"daemonIdleMs", context_.daemon_idle_ms}};
        {
            std::scoped_lock lock(queue_mutex_);
            result["queuedRequests"] = queued_.size();
            result["activeRequests"] = active_.size();
        }
        result["criticalSections"] = critical_sections_.load();
        {
            std::scoped_lock lock(queue_mutex_);
            result["projectOwnerWorkers"] = project_owners_.size();
            result["projectSessions"] = project_owners_.size() + generic_project_sessions_.load();
            result["disposableWorkers"] = disposable_workers_.size();
            result["disposableQueuedJobs"] = prepared_disposable_.size();
            result["disposableStandbyWorkers"] = std::count_if(
                disposable_workers_.begin(), disposable_workers_.end(), [](const auto& entry) {
                    return entry.second.state == DisposableWorkerState::starting ||
                           entry.second.state == DisposableWorkerState::idle;
                });
            result["disposableBusyWorkers"] = std::count_if(
                disposable_workers_.begin(), disposable_workers_.end(), [](const auto& entry) {
                    return entry.second.state == DisposableWorkerState::busy;
                });
            result["engineeringOwnerPids"] = Json::array();
            for (const auto& [id, owner] : project_owners_) {
                (void)id;
#if defined(_WIN32)
                result["engineeringOwnerPids"].push_back(owner.process.pid);
#else
                result["engineeringOwnerPids"].push_back(owner.process.pid);
#endif
            }
            result["engineeringDisposablePids"] = Json::array();
            for (const auto& [id, worker] : disposable_workers_) {
                (void)id;
#if defined(_WIN32)
                result["engineeringDisposablePids"].push_back(worker.process.pid);
#else
                result["engineeringDisposablePids"].push_back(worker.process.pid);
#endif
            }
        }
        result["projectAuthorities"] = project_authority_.tracked_project_count();
        result["projectSnapshots"] = project_snapshots_.snapshot_count();
        result["projectSnapshotBytes"] = project_snapshots_.retained_bytes();
        result["engineeringCounters"] = {
            {"authorityObservations", authority_observations_.load()},
            {"filesObserved", files_observed_.load()},
            {"changedPaths", changed_paths_.load()},
            {"nativeBoundaryCalls", native_boundary_calls_.load()},
            {"ownerSpawns", owner_spawns_.load()},
            {"ownerColdAdmissions", owner_cold_admissions_.load()},
            {"ownerRehydrations", owner_rehydrations_.load()},
            {"exactResultHits", exact_result_hits_.load()},
            {"generationPromotions", generation_promotions_.load()},
            {"snapshotPublications", snapshot_publications_.load()},
            {"snapshotHandoffs", snapshot_handoffs_.load()},
            {"disposableSpawns", disposable_spawns_.load()},
            {"disposableQueues", disposable_queues_.load()},
            {"ownerRetirements", owner_retirements_.load()},
            {"disposableRetirements", disposable_retirements_.load()},
        };
        return result;
    }

    const BrokerContext& context() const { return context_; }

private:
    enum class State {
        starting,
        ready,
        draining,
        stopped
    };

    static const char* state_name(State state)
    {
        switch (state) {
        case State::starting:
            return "starting";
        case State::ready:
            return "ready";
        case State::draining:
            return "draining";
        case State::stopped:
            return "stopped";
        }
        return "stopped";
    }

    static std::uint64_t current_pid()
    {
#if defined(_WIN32)
        return static_cast<std::uint64_t>(GetCurrentProcessId());
#else
        return static_cast<std::uint64_t>(getpid());
#endif
    }

    static Json error_json(std::string message)
    {
        return {{"ok", false}, {"error", std::move(message)}};
    }

    void touch() { last_activity_millis_.store(now_millis()); }

    void record_authority_observation(const ProjectObservation& observation)
    {
        authority_observations_.fetch_add(1);
        files_observed_.fetch_add(observation.manifest.entries.size());
        changed_paths_.fetch_add(observation.delta.added.size() + observation.delta.changed.size() +
                                 observation.delta.removed.size());
    }

    bool touch_owner(std::uint64_t owner_worker_id)
    {
        std::scoped_lock lock(queue_mutex_);
        const auto found = project_owners_.find(owner_worker_id);
        if (found == project_owners_.end() || found->second.retiring)
            return false;
        found->second.last_activity_millis = now_millis();
        return true;
    }

    static constexpr std::size_t disposable_worker_cap = 4;
    static constexpr std::uint64_t disposable_cancel_grace_ms = 100;

    std::size_t live_disposable_workers_locked() const
    {
        // Retiring children still count until their process has actually exited. This keeps the
        // cap a bound on physical ScriptC worker processes, not merely schedulable workers.
        return disposable_workers_.size();
    }

    bool has_disposable_standby_locked() const
    {
        return std::any_of(disposable_workers_.begin(), disposable_workers_.end(),
                           [](const auto& entry) {
                               return entry.second.state == DisposableWorkerState::starting ||
                                      entry.second.state == DisposableWorkerState::idle;
                           });
    }

    bool start_disposable_worker_locked()
    {
        if (!context_.disposable_worker_processes_enabled)
            return false;
        if (live_disposable_workers_locked() >= disposable_worker_cap)
            return false;
        const auto worker_id = next_disposable_worker_id_.fetch_add(1);
        auto process = spawn_disposable_worker_process(context_, worker_id);
        if (!process)
            return false;
        disposable_spawns_.fetch_add(1);
        disposable_workers_.emplace(worker_id, DisposableWorker{
                                                   .id = worker_id,
                                                   .process = *process,
                                                   .state = DisposableWorkerState::starting,
                                                   .assignment = std::nullopt,
                                                   .last_activity_millis = now_millis(),
                                               });
        return true;
    }

    void ensure_disposable_standby_locked()
    {
        if (!context_.disposable_worker_processes_enabled)
            return;
        if (!has_disposable_standby_locked())
            (void)start_disposable_worker_locked();
    }

    void assign_disposable_jobs_locked()
    {
        while (!prepared_disposable_.empty()) {
            const auto idle = std::find_if(
                disposable_workers_.begin(), disposable_workers_.end(), [](const auto& entry) {
                    return entry.second.state == DisposableWorkerState::idle &&
                           !entry.second.assignment;
                });
            if (idle == disposable_workers_.end()) {
                ensure_disposable_standby_locked();
                break;
            }
            idle->second.assignment = std::move(prepared_disposable_.front());
            prepared_disposable_.erase(prepared_disposable_.begin());
            idle->second.state = DisposableWorkerState::busy;
            idle->second.last_activity_millis = now_millis();
            ensure_disposable_standby_locked();
            disposable_cv_.notify_all();
        }
    }

    bool request_id_pending_locked(const std::shared_ptr<ClientConnection>& client,
                                   std::string_view request_id) const
    {
        const auto matches = [&](const QueuedRequest& queued) {
            return queued.request_id == request_id && queued.client.lock() == client;
        };
        if (std::find_if(queued_.begin(), queued_.end(), matches) != queued_.end())
            return true;
        for (const auto& [id, owner] : project_owners_) {
            (void)id;
            if (std::find_if(owner.queued.begin(), owner.queued.end(), matches) !=
                owner.queued.end())
                return true;
        }
        if (std::find_if(prepared_disposable_.begin(), prepared_disposable_.end(),
                         [&](const PreparedDisposableRequest& prepared) {
                             return matches(prepared.request);
                         }) != prepared_disposable_.end())
            return true;
        for (const auto& [id, worker] : disposable_workers_) {
            (void)id;
            if (worker.assignment && matches(worker.assignment->request))
                return true;
        }
        for (const auto& [token, active] : active_) {
            (void)token;
            if (active.request_id == request_id && active.client.lock() == client)
                return true;
        }
        return false;
    }

    std::optional<std::uint64_t> ensure_project_owner_locked(const std::string& canonical_root)
    {
        if (const auto existing = project_owner_by_root_.find(canonical_root);
            existing != project_owner_by_root_.end()) {
            const auto owner = project_owners_.find(existing->second);
            if (owner != project_owners_.end() && !owner->second.retiring &&
                child_process_alive(owner->second.process))
                return owner->first;
            return std::nullopt;
        }

        const auto owner_worker_id = next_owner_worker_id_.fetch_add(1);
        const auto cold_session_epoch = next_project_session_epoch_.fetch_add(1);
        auto retained_snapshot = project_snapshots_.latest(canonical_root, now_millis());
        if (retained_snapshot) {
            const auto checkpoint = project_snapshots_.authority_checkpoint(
                canonical_root, retained_snapshot->identity, now_millis());
            if (!checkpoint ||
                !project_authority_.restore_checkpoint_for_rehydration(*checkpoint)) {
                project_snapshots_.invalidate_current(canonical_root);
                retained_snapshot.reset();
            }
        }
        auto process = spawn_project_owner_process(context_, owner_worker_id);
        if (!process)
            return std::nullopt;
        owner_spawns_.fetch_add(1);
        if (retained_snapshot)
            owner_rehydrations_.fetch_add(1);
        else
            owner_cold_admissions_.fetch_add(1);
        ProjectOwnerWorker owner;
        owner.id = owner_worker_id;
        owner.canonical_root = canonical_root;
        owner.cold_session_epoch = cold_session_epoch;
        if (retained_snapshot)
            owner.retained_session_epoch = retained_snapshot->identity.session_epoch;
        owner.process = *process;
        owner.last_activity_millis = now_millis();
        project_owners_.emplace(owner_worker_id, std::move(owner));
        project_owner_by_root_[canonical_root] = owner_worker_id;
        owner_cv_.notify_all();
        return owner_worker_id;
    }

    std::optional<Json> exact_validation_hit(const std::string& canonical_root, const Json& payload)
    {
        if (!payload.is_object() || !payload.contains("argv") || !payload["argv"].is_array() ||
            std::find(payload["argv"].begin(), payload["argv"].end(), "validate") ==
                payload["argv"].end())
            return std::nullopt;
        const auto semantic_key = payload.value("authoringValidationSemanticKey", std::string{});
        if (semantic_key.empty())
            return std::nullopt;

        std::optional<ExactValidationResult> retained;
        {
            std::scoped_lock lock(validation_mutex_);
            const auto found = exact_validation_results_.find(canonical_root);
            if (found == exact_validation_results_.end() ||
                found->second.semantic_key != semantic_key)
                return std::nullopt;
            retained = found->second;
        }

#if defined(_WIN32)
        const std::filesystem::path root = utf8_to_wide(canonical_root);
#else
        const std::filesystem::path root = canonical_root;
#endif
        bool active_owner = false;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto mapped = project_owner_by_root_.find(canonical_root);
            if (mapped != project_owner_by_root_.end()) {
                const auto owner = project_owners_.find(mapped->second);
                active_owner = owner != project_owners_.end() && !owner->second.retiring &&
                               child_process_alive(owner->second.process);
                if (active_owner) {
                    const bool request_active =
                        std::any_of(active_.begin(), active_.end(),
                                    [owner_worker_id = owner->first](const auto& item) {
                                        return item.second.owner_worker_id == owner_worker_id;
                                    });
                    if (!owner->second.queued.empty() || request_active ||
                        owner->second.critical_sections != 0 || owner->second.reconciling)
                        return std::nullopt;
                }
            }
        }
        if (active_owner) {
            const auto current = project_authority_.checkpoint(root);
            if (!current || *current != retained->authority)
                return std::nullopt;
        } else {
            try {
                const auto observation = project_authority_.observe(ProjectAuthorityRequest{
                    .project_root = root,
                    .authoritative_paths = retained->authority.authoritative_paths,
                    .discovery_scopes = retained->authority.discovery_scopes,
                });
                record_authority_observation(observation);
                if (observation.manifest != retained->authority.manifest) {
                    std::scoped_lock lock(validation_mutex_);
                    const auto found = exact_validation_results_.find(canonical_root);
                    if (found != exact_validation_results_.end() &&
                        found->second.revision == retained->revision)
                        exact_validation_results_.erase(found);
                    return std::nullopt;
                }
                const auto current = project_authority_.checkpoint(root);
                if (!current || *current != retained->authority)
                    return std::nullopt;
                // Owner eviction stops watcher coverage. The exact result remains reusable in
                // native memory, but every later ownerless hit must prove disk again rather than
                // leaving a dormant Project watcher alive indefinitely.
                (void)project_authority_.suspend(root);
            } catch (...) {
                return std::nullopt;
            }
        }
        return payload.value("outputMode", std::string{}) == "json" ? retained->json_result
                                                                    : retained->human_result;
    }

    std::optional<std::string>
    queue_disposable_request(const std::shared_ptr<ClientConnection>& client,
                             const std::string& request_id, const std::string& method,
                             const Json& payload)
    {
        std::scoped_lock lock(queue_mutex_);
        if (state_.load() == State::draining || state_.load() == State::stopped)
            return "daemon is draining";
        if (request_id_pending_locked(client, request_id))
            return "duplicate pending daemon request id";
        if (!context_.disposable_worker_processes_enabled)
            return "daemon disposable workers are unavailable";
        prepared_disposable_.push_back(PreparedDisposableRequest{
            .request =
                QueuedRequest{
                    .client = client,
                    .request_id = request_id,
                    .method = method,
                    .payload = payload,
                    .prepare_disposable = false,
                },
            .canonical_root = {},
            .identity = std::nullopt,
        });
        disposable_queues_.fetch_add(1);
        assign_disposable_jobs_locked();
        ensure_disposable_standby_locked();
        touch();
        disposable_cv_.notify_all();
        return std::nullopt;
    }

    std::optional<std::string>
    queue_project_owner_request(const std::shared_ptr<ClientConnection>& client,
                                const std::string& request_id, const std::string& method,
                                const Json& payload)
    {
        if (method != "invoke" || !payload.is_object() || !payload.contains("ownerProjectRoot") ||
            payload["ownerProjectRoot"].is_null())
            return std::string{};
        if (!payload["ownerProjectRoot"].is_string() ||
            payload["ownerProjectRoot"].get_ref<const std::string&>().empty())
            return "daemon Project owner root is malformed";

        std::string canonical_root;
        try {
            const bool explicit_project = payload.value("ownerProjectRootExplicit", false);
            canonical_root = canonical_project_owner_root(
                payload["ownerProjectRoot"].get_ref<const std::string&>(), !explicit_project);
            if (canonical_root.empty())
                return std::string{};
        } catch (const std::exception& error) {
            return error.what();
        }

        for (;;) {
            std::optional<std::uint64_t> dead_owner;
            {
                std::unique_lock lock(queue_mutex_);
                if (state_.load() == State::draining || state_.load() == State::stopped)
                    return "daemon is draining";
                if (request_id_pending_locked(client, request_id))
                    return "duplicate pending daemon request id";
                if (exact_validation_probe_roots_.contains(canonical_root)) {
                    owner_cv_.wait(lock, [this, &canonical_root] {
                        return state_.load() == State::draining ||
                               state_.load() == State::stopped ||
                               !exact_validation_probe_roots_.contains(canonical_root);
                    });
                    continue;
                }
                if (const auto mapped = project_owner_by_root_.find(canonical_root);
                    mapped != project_owner_by_root_.end()) {
                    const auto owner = project_owners_.find(mapped->second);
                    if (owner == project_owners_.end()) {
                        project_owner_by_root_.erase(mapped);
                    } else if (owner->second.retiring) {
                        owner_cv_.wait(lock, [this, &canonical_root,
                                              owner_worker_id = owner->first] {
                            if (state_.load() == State::draining || state_.load() == State::stopped)
                                return true;
                            const auto mapped = project_owner_by_root_.find(canonical_root);
                            return mapped == project_owner_by_root_.end() ||
                                   mapped->second != owner_worker_id;
                        });
                        continue;
                    } else if (!child_process_alive(owner->second.process)) {
                        dead_owner = owner->first;
                    }
                }
                if (!dead_owner) {
                    bool exact_candidate = false;
                    const auto semantic_key =
                        payload.value("authoringValidationSemanticKey", std::string{});
                    if (!semantic_key.empty()) {
                        std::scoped_lock validation_lock(validation_mutex_);
                        const auto retained = exact_validation_results_.find(canonical_root);
                        exact_candidate = retained != exact_validation_results_.end() &&
                                          retained->second.semantic_key == semantic_key;
                    }
                    if (exact_candidate) {
                        bool owner_idle = true;
                        if (const auto mapped = project_owner_by_root_.find(canonical_root);
                            mapped != project_owner_by_root_.end()) {
                            const auto owner = project_owners_.find(mapped->second);
                            if (owner != project_owners_.end()) {
                                const bool request_active = std::any_of(
                                    active_.begin(), active_.end(),
                                    [owner_worker_id = owner->first](const auto& item) {
                                        return item.second.owner_worker_id == owner_worker_id;
                                    });
                                owner_idle = owner->second.queued.empty() && !request_active &&
                                             !owner->second.dispatching &&
                                             owner->second.critical_sections == 0 &&
                                             !owner->second.reconciling;
                            }
                        }
                        if (owner_idle) {
                            exact_validation_probe_roots_.insert(canonical_root);
                            exact_validation_probes_.fetch_add(1);
                            lock.unlock();
                            const auto exact = exact_validation_hit(canonical_root, payload);
                            lock.lock();
                            exact_validation_probe_roots_.erase(canonical_root);
                            exact_validation_probes_.fetch_sub(1);
                            owner_cv_.notify_all();
                            active_cv_.notify_all();
                            if (exact) {
                                exact_result_hits_.fetch_add(1);
                                lock.unlock();
                                client->send(result_event_json(request_id, true, exact->dump()));
                                touch();
                                return std::nullopt;
                            }
                        }
                    }
                    if (state_.load() == State::draining || state_.load() == State::stopped)
                        return "daemon is draining";
                    if (request_id_pending_locked(client, request_id))
                        return "duplicate pending daemon request id";
                    if (const auto mapped = project_owner_by_root_.find(canonical_root);
                        mapped != project_owner_by_root_.end()) {
                        const auto owner = project_owners_.find(mapped->second);
                        if (owner == project_owners_.end()) {
                            project_owner_by_root_.erase(mapped);
                        } else if (owner->second.retiring) {
                            continue;
                        } else if (!child_process_alive(owner->second.process)) {
                            dead_owner = owner->first;
                        }
                    }
                    if (!dead_owner) {
                        const auto owner_worker_id = ensure_project_owner_locked(canonical_root);
                        if (!owner_worker_id)
                            return "failed to start daemon Project owner worker";
                        auto& owner = project_owners_.at(*owner_worker_id);
                        owner.queued.push_back(QueuedRequest{
                            .client = client,
                            .request_id = request_id,
                            .method = method,
                            .payload = payload,
                            .prepare_disposable = payload.value("executionClass", std::string{}) ==
                                                  "disposable-heavy",
                        });
                        owner.last_activity_millis = now_millis();
                        owner_cv_.notify_all();
                        touch();
                        return std::nullopt;
                    }
                }
            }
            retire_project_owner(*dead_owner, "daemon Project owner exited unexpectedly", true);
        }
    }

    void retire_project_owner(std::uint64_t owner_worker_id, std::string_view reason,
                              bool process_already_dead = false)
    {
        ChildProcess process;
        std::string canonical_root;
        std::vector<QueuedRequest> queued;
        std::vector<ActiveRequest> active;
        std::uint64_t owner_critical_sections = 0;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found = project_owners_.find(owner_worker_id);
            if (found == project_owners_.end())
                return;
            if (found->second.retirement_started)
                return;
            found->second.retiring = true;
            found->second.retirement_started = true;
            owner_retirements_.fetch_add(1);
            process = found->second.process;
            canonical_root = found->second.canonical_root;
            queued = std::move(found->second.queued);
            found->second.queued.clear();
            owner_critical_sections = found->second.critical_sections;
            found->second.critical_sections = 0;
            for (auto iterator = active_.begin(); iterator != active_.end();) {
                if (iterator->second.owner_worker_id == owner_worker_id) {
                    active.push_back(iterator->second);
                    iterator = active_.erase(iterator);
                } else {
                    ++iterator;
                }
            }
        }
        if (owner_critical_sections != 0) {
            {
                std::scoped_lock lock(critical_mutex_);
                const auto current = critical_sections_.load();
                critical_sections_.store(
                    current >= owner_critical_sections ? current - owner_critical_sections : 0);
            }
            critical_cv_.notify_all();
        }
        owner_cv_.notify_all();
        active_cv_.notify_all();
#if defined(_WIN32)
        const std::filesystem::path root = utf8_to_wide(canonical_root);
#else
        const std::filesystem::path root = canonical_root;
#endif
        if (process_already_dead)
            release_child_process(process);
        else
            terminate_child_process(process);
        const auto retained_snapshot = project_snapshots_.latest(canonical_root, now_millis());
        std::optional<ProjectAuthorityCheckpoint> exact_validation_checkpoint;
        {
            std::scoped_lock lock(validation_mutex_);
            const auto found = exact_validation_results_.find(canonical_root);
            if (found != exact_validation_results_.end())
                exact_validation_checkpoint = found->second.authority;
        }
        bool retained_for_rehydration = false;
        if (exact_validation_checkpoint) {
            // Exact validation survives owner eviction independently of portable semantic bytes.
            // Install its native physical baseline dormant so the next validation can prove disk
            // equality without starting QuickJS. A later owner admission restores its own retained
            // snapshot checkpoint before rehydration.
            retained_for_rehydration =
                project_authority_.restore_checkpoint_for_rehydration(*exact_validation_checkpoint);
        } else if (retained_snapshot) {
            // Snapshot serialization is allowed to lag the live owner. Always restore the exact
            // native baseline captured with the retained bytes before making the Project dormant;
            // otherwise a replacement could rehydrate generation N-1 against generation N's
            // already-advanced manifest and incorrectly observe no delta. The same rule recovers
            // changes a crashed owner consumed after its last snapshot.
            const auto checkpoint = project_snapshots_.authority_checkpoint(
                canonical_root, retained_snapshot->identity, now_millis());
            retained_for_rehydration =
                checkpoint && project_authority_.restore_checkpoint_for_rehydration(*checkpoint);
        }
        if (!retained_for_rehydration) {
            if (retained_snapshot)
                project_snapshots_.invalidate_current(canonical_root);
            (void)project_authority_.release(root);
        }
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found = project_owners_.find(owner_worker_id);
            if (found != project_owners_.end())
                project_owners_.erase(found);
            if (const auto mapped = project_owner_by_root_.find(canonical_root);
                mapped != project_owner_by_root_.end() && mapped->second == owner_worker_id)
                project_owner_by_root_.erase(mapped);
        }
        owner_cv_.notify_all();
        for (const auto& request : queued) {
            if (const auto client = request.client.lock())
                client->send(result_event_json(request.request_id, false, "null", reason));
        }
        for (const auto& request : active) {
            if (const auto client = request.client.lock())
                client->send(result_event_json(request.request_id, false, "null", reason));
        }
    }

    void retire_all_project_owners(std::string_view reason)
    {
        std::vector<std::uint64_t> owners;
        {
            std::scoped_lock lock(queue_mutex_);
            owners.reserve(project_owners_.size());
            for (const auto& [id, owner] : project_owners_) {
                (void)owner;
                owners.push_back(id);
            }
        }
        for (const auto id : owners)
            retire_project_owner(id, reason);
    }

    void retire_all_disposable_workers(std::string_view reason)
    {
        std::vector<ChildProcess> processes;
        std::vector<PreparedDisposableRequest> pinned;
        std::vector<ActiveRequest> active;
        {
            std::scoped_lock lock(queue_mutex_);
            processes.reserve(disposable_workers_.size());
            for (auto& [id, worker] : disposable_workers_) {
                (void)id;
                processes.push_back(worker.process);
                if (worker.assignment)
                    pinned.push_back(std::move(*worker.assignment));
            }
            disposable_workers_.clear();
            pinned.insert(pinned.end(), std::make_move_iterator(prepared_disposable_.begin()),
                          std::make_move_iterator(prepared_disposable_.end()));
            prepared_disposable_.clear();
            for (auto iterator = active_.begin(); iterator != active_.end();) {
                if (iterator->second.disposable_worker_id) {
                    active.push_back(iterator->second);
                    iterator = active_.erase(iterator);
                } else {
                    ++iterator;
                }
            }
        }
        for (auto& process : processes)
            terminate_child_process(process);
        for (const auto& request : pinned) {
            if (request.identity)
                (void)project_snapshots_.unpin(request.canonical_root, *request.identity,
                                               now_millis());
            if (const auto client = request.request.client.lock())
                client->send(result_event_json(request.request.request_id, false, "null", reason));
        }
        for (const auto& request : active) {
            if (request.pinned_generation)
                (void)project_snapshots_.unpin(request.pinned_project_root,
                                               *request.pinned_generation, now_millis());
            if (const auto client = request.client.lock())
                client->send(result_event_json(request.request_id, false, "null", reason));
        }
        disposable_cv_.notify_all();
        active_cv_.notify_all();
    }

    void maintain_project_owners()
    {
        constexpr std::size_t owner_soft_limit = 8;
        std::vector<std::pair<std::uint64_t, bool>> retire;
        std::vector<std::pair<std::uint64_t, std::uint64_t>> pressure_candidates;
        const auto now = now_millis();
        {
            std::scoped_lock lock(queue_mutex_);
            std::size_t non_retiring_owners = 0;
            const auto owner_is_active = [&](std::uint64_t id) {
                return std::any_of(active_.begin(), active_.end(), [&](const auto& item) {
                    return item.second.owner_worker_id == id;
                });
            };
            for (const auto& [id, owner] : project_owners_) {
                if (owner.retiring)
                    continue;
                ++non_retiring_owners;
                if (!child_process_alive(owner.process)) {
                    retire.emplace_back(id, true);
                    continue;
                }
                if (!owner.queued.empty() || owner.dispatching || owner_is_active(id) ||
                    owner.critical_sections != 0 || owner.reconciling ||
                    exact_validation_probe_roots_.contains(owner.canonical_root))
                    continue;
                const bool idle_expired =
                    now - owner.last_activity_millis >= context_.project_session_idle_ms;
                if (idle_expired)
                    retire.emplace_back(id, false);
                else
                    pressure_candidates.emplace_back(owner.last_activity_millis, id);
            }
            const auto survivors = non_retiring_owners - retire.size();
            if (survivors > owner_soft_limit) {
                std::sort(pressure_candidates.begin(), pressure_candidates.end());
                const auto pressure_evictions =
                    std::min(survivors - owner_soft_limit, pressure_candidates.size());
                for (std::size_t index = 0; index < pressure_evictions; ++index)
                    retire.emplace_back(pressure_candidates[index].second, false);
            }
            for (const auto& [id, already_dead] : retire) {
                (void)already_dead;
                const auto owner = project_owners_.find(id);
                if (owner != project_owners_.end())
                    owner->second.retiring = true;
            }
        }
        for (const auto& [id, already_dead] : retire)
            retire_project_owner(id,
                                 already_dead ? "daemon Project owner exited unexpectedly"
                                              : "daemon Project owner was evicted",
                                 already_dead);
        std::vector<std::string> active_roots;
        {
            std::scoped_lock lock(queue_mutex_);
            active_roots.reserve(project_owners_.size());
            for (const auto& [id, owner] : project_owners_) {
                (void)id;
                if (!owner.retiring)
                    active_roots.push_back(owner.canonical_root);
            }
        }
        project_snapshots_.trim_dormant_to_budget(active_roots,
                                                  default_project_snapshot_budget_bytes);
    }

    void maintain_disposable_workers()
    {
        struct Retirement {
            std::uint64_t id = 0;
            ChildProcess process;
            bool already_dead = false;
            bool cancelled = false;
            std::optional<PreparedDisposableRequest> assignment;
            std::optional<ActiveRequest> active;
        };
        std::vector<Retirement> retirements;
        const auto now = now_millis();
        {
            std::scoped_lock lock(queue_mutex_);
            std::size_t standby_count = std::count_if(
                disposable_workers_.begin(), disposable_workers_.end(), [](const auto& entry) {
                    return entry.second.state == DisposableWorkerState::starting ||
                           entry.second.state == DisposableWorkerState::idle;
                });
            for (auto& [id, worker] : disposable_workers_) {
                const bool was_standby = worker.state == DisposableWorkerState::starting ||
                                         worker.state == DisposableWorkerState::idle;
                const bool alive = child_process_alive(worker.process);
                auto active = std::find_if(active_.begin(), active_.end(), [&](const auto& entry) {
                    return entry.second.disposable_worker_id == id;
                });
                const bool cancellation_expired =
                    active != active_.end() && active->second.cancelled &&
                    active->second.cancellation_requested_millis != 0 &&
                    now - active->second.cancellation_requested_millis >=
                        disposable_cancel_grace_ms;
                const bool excess_idle_expired =
                    worker.state == DisposableWorkerState::idle && standby_count > 1 &&
                    now - worker.last_activity_millis >= context_.disposable_extra_idle_ms;
                if (alive && worker.state != DisposableWorkerState::retiring &&
                    !cancellation_expired && !excess_idle_expired)
                    continue;

                Retirement retirement{
                    .id = id,
                    .process = worker.process,
                    .already_dead = !alive,
                    .cancelled = cancellation_expired,
                    .assignment = std::move(worker.assignment),
                    .active = std::nullopt,
                };
                worker.assignment.reset();
                worker.state = DisposableWorkerState::retiring;
                if (was_standby && standby_count > 0)
                    --standby_count;
                if (active != active_.end()) {
                    retirement.active = active->second;
                    active_.erase(active);
                }
                retirements.push_back(std::move(retirement));
            }
        }

        for (auto& retirement : retirements) {
            if (retirement.already_dead)
                release_child_process(retirement.process);
            else
                terminate_child_process(retirement.process);
            if (retirement.assignment && retirement.assignment->identity)
                (void)project_snapshots_.unpin(retirement.assignment->canonical_root,
                                               *retirement.assignment->identity, now_millis());
            if (retirement.active && retirement.active->pinned_generation) {
                (void)project_snapshots_.unpin(retirement.active->pinned_project_root,
                                               *retirement.active->pinned_generation, now_millis());
                if (const auto client = retirement.active->client.lock()) {
                    Json event = Json::parse(result_event_json(
                        retirement.active->request_id, false, "null",
                        retirement.cancelled ? "request cancelled"
                                             : "daemon disposable worker exited unexpectedly"));
                    if (retirement.cancelled)
                        event["cancelled"] = true;
                    client->send(event.dump());
                }
            }
            if (retirement.assignment) {
                if (const auto client = retirement.assignment->request.client.lock())
                    client->send(result_event_json(
                        retirement.assignment->request.request_id, false, "null",
                        retirement.cancelled ? "request cancelled"
                                             : "daemon disposable worker exited unexpectedly"));
            }
        }
        if (!retirements.empty()) {
            disposable_retirements_.fetch_add(retirements.size());
            std::scoped_lock lock(queue_mutex_);
            for (const auto& retirement : retirements)
                disposable_workers_.erase(retirement.id);
            if (state_.load() == State::ready) {
                assign_disposable_jobs_locked();
                ensure_disposable_standby_locked();
            }
            disposable_cv_.notify_all();
            active_cv_.notify_all();
        }
    }

    static std::uint64_t now_millis()
    {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch())
                .count());
    }

    static std::optional<std::filesystem::path>
    authoring_cache_directory(const std::filesystem::path& root)
    {
        auto directory = root;
        for (const auto* segment : {".noveltea", "cache", "authoring"}) {
            directory /= segment;
            std::error_code error;
            auto status = std::filesystem::symlink_status(directory, error);
            if (error)
                return std::nullopt;
            if (status.type() == std::filesystem::file_type::not_found) {
                if (!std::filesystem::create_directory(directory, error) || error)
                    return std::nullopt;
                status = std::filesystem::symlink_status(directory, error);
            }
            if (error || std::filesystem::is_symlink(status) ||
                !std::filesystem::is_directory(status))
                return std::nullopt;
        }
        return directory;
    }

    static bool write_text_atomic(const std::filesystem::path& destination, std::string_view text,
                                  std::uint64_t revision)
    {
        auto temporary = destination;
        temporary += ".tmp-" + std::to_string(revision);
        {
            std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
            if (!output) {
                std::error_code cleanup_error;
                std::filesystem::remove(temporary, cleanup_error);
                return false;
            }
            output.write(text.data(), static_cast<std::streamsize>(text.size()));
            output.flush();
            if (!output) {
                output.close();
                std::error_code cleanup_error;
                std::filesystem::remove(temporary, cleanup_error);
                return false;
            }
        }
        bool replaced = false;
#if defined(_WIN32)
        replaced = MoveFileExW(temporary.c_str(), destination.c_str(),
                               MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
#else
        std::error_code error;
        std::filesystem::rename(temporary, destination, error);
        replaced = !error;
#endif
        if (!replaced) {
            std::error_code cleanup_error;
            std::filesystem::remove(temporary, cleanup_error);
        }
        return replaced;
    }

    void publish_pending_validation_cache()
    {
        std::optional<ExactValidationResult> pending;
        {
            std::scoped_lock lock(validation_mutex_);
            if (pending_validation_publications_.empty())
                return;
            pending = pending_validation_publications_.begin()->second;
        }

#if defined(_WIN32)
        const std::filesystem::path root = utf8_to_wide(pending->canonical_root);
#else
        const std::filesystem::path root = pending->canonical_root;
#endif
        Json inputs = Json::array();
        bool persistable = true;
        for (const auto& entry : pending->authority.manifest.entries) {
            if (!entry.mtime_nanoseconds || entry.source_identity.empty()) {
                persistable = false;
                break;
            }
            inputs.push_back({{"path", entry.path},
                              {"sourceIdentity", entry.source_identity},
                              {"byteSize", entry.byte_size},
                              {"mtimeNanoseconds", std::to_string(*entry.mtime_nanoseconds)}});
        }
        Json scopes = Json::array();
        for (const auto& scope : pending->authority.discovery_scopes)
            scopes.push_back({{"root", scope.root},
                              {"extensions", scope.extensions},
                              {"excludedPrefixes", scope.excluded_prefixes}});
        if (persistable) {
            const Json manifest = {{"schema", "noveltea.authoring-cache"},
                                   {"semanticKey", pending->semantic_key},
                                   {"projectRoot", pending->canonical_root},
                                   {"discoveryScopes", std::move(scopes)},
                                   {"inputs", std::move(inputs)},
                                   {"result", pending->structured_result}};
            if (const auto directory = authoring_cache_directory(root))
                (void)write_text_atomic(*directory / "current.json", manifest.dump() + "\n",
                                        pending->revision);
        }

        // Persistence is disposable acceleration. A failed write is dropped rather than retried on
        // the foreground path; a newer exact result will enqueue a fresh best-effort publication.
        {
            std::scoped_lock lock(validation_mutex_);
            const auto found = pending_validation_publications_.find(pending->canonical_root);
            if (found != pending_validation_publications_.end() &&
                found->second.revision == pending->revision)
                pending_validation_publications_.erase(found);
        }
    }

    void create_listener()
    {
        last_activity_millis_.store(now_millis());
#if defined(_WIN32)
        auto security_owner = current_user_security_descriptor();
        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.lpSecurityDescriptor = security_owner.descriptor;
        attributes.bInheritHandle = FALSE;
        lifetime_mutex_ = CreateMutexW(&attributes, FALSE, endpoint_.lifetime_mutex_name.c_str());
        if (lifetime_mutex_ == nullptr)
            throw std::runtime_error("failed to create daemon lifetime mutex");
        const auto ownership = WaitForSingleObject(lifetime_mutex_, 0);
        if (ownership != WAIT_OBJECT_0 && ownership != WAIT_ABANDONED) {
            CloseHandle(lifetime_mutex_);
            lifetime_mutex_ = nullptr;
            throw std::runtime_error("failed to acquire daemon lifetime ownership");
        }
        lifetime_mutex_owned_ = true;
        // Windows creates one named-pipe instance per accepted client in listen_loop().
#else
        lifetime_lock_ =
            ::open(endpoint_.lifetime_lock_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
        if (lifetime_lock_ < 0 || ::fchmod(lifetime_lock_, 0600) != 0 ||
            ::flock(lifetime_lock_, LOCK_EX | LOCK_NB) != 0) {
            if (lifetime_lock_ >= 0) {
                ::close(lifetime_lock_);
                lifetime_lock_ = -1;
            }
            throw std::runtime_error("failed to acquire daemon lifetime ownership");
        }
        listener_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (listener_ < 0)
            throw std::runtime_error("failed to create daemon Unix-domain socket");
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        const auto socket_text = endpoint_.socket_path.string();
        std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
        if (::bind(listener_, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0) {
            const auto reason = std::string(std::strerror(errno));
            ::close(listener_);
            listener_ = -1;
            throw std::runtime_error("failed to bind daemon Unix-domain socket: " + reason);
        }
        if (::chmod(endpoint_.socket_path.c_str(), 0600) != 0) {
            close_listener();
            throw std::runtime_error("failed to restrict daemon socket permissions");
        }
        if (::listen(listener_, 32) != 0) {
            close_listener();
            throw std::runtime_error("failed to listen on daemon Unix-domain socket");
        }
#endif
    }

#if defined(_WIN32)
    HANDLE create_pipe_instance()
    {
        auto security_owner = current_user_security_descriptor();
        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.lpSecurityDescriptor = security_owner.descriptor;
        attributes.bInheritHandle = FALSE;
        const auto pipe = CreateNamedPipeW(
            endpoint_.pipe_name.c_str(), PIPE_ACCESS_DUPLEX,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES, static_cast<DWORD>(max_frame_bytes + 4),
            static_cast<DWORD>(max_frame_bytes + 4), 0, &attributes);
        if (pipe == INVALID_HANDLE_VALUE)
            throw std::runtime_error("failed to create current-user daemon named pipe");
        return pipe;
    }
#endif

    void listen_loop()
    {
        while (state_.load() != State::draining && state_.load() != State::stopped) {
            ConnectionHandle connection = invalid_connection;
#if defined(_WIN32)
            try {
                connection = create_pipe_instance();
            } catch (...) {
                request_stop();
                break;
            }
            {
                std::scoped_lock lock(listener_mutex_);
                pending_pipe_ = connection;
            }
            const BOOL connected = ConnectNamedPipe(connection, nullptr)
                                       ? TRUE
                                       : (GetLastError() == ERROR_PIPE_CONNECTED);
            {
                std::scoped_lock lock(listener_mutex_);
                if (pending_pipe_ == connection)
                    pending_pipe_ = invalid_connection;
            }
            if (!connected) {
                CloseHandle(connection);
                if (state_.load() == State::draining || state_.load() == State::stopped)
                    break;
                continue;
            }
#else
            connection = ::accept(listener_, nullptr, nullptr);
            if (connection < 0) {
                if (errno == EINTR)
                    continue;
                if (state_.load() == State::draining || state_.load() == State::stopped)
                    break;
                request_stop();
                break;
            }
#endif
            auto client = std::make_shared<ClientConnection>(connection);
            {
                std::scoped_lock lock(clients_mutex_);
                clients_.insert(client);
                client_threads_.emplace_back([self = shared_from_this(), client] {
                    self->client_loop(client);
                    std::scoped_lock lock(self->clients_mutex_);
                    self->clients_.erase(client);
                });
            }
        }
        finish_if_safe();
    }

    void client_loop(const std::shared_ptr<ClientConnection>& client)
    {
        while (state_.load() != State::stopped) {
            const auto handle = client->current();
            if (handle == invalid_connection)
                break;
            const auto payload = receive_payload(handle);
            if (!payload)
                break;
            const auto message = Json::parse(*payload, nullptr, false);
            if (message.is_discarded() || !message.is_object())
                break;
            const auto type = message.value("type", std::string{});
            const auto request_id = message.value("requestId", std::string{});
            if (request_id.empty())
                break;
            if (type == "cancel") {
                touch();
                cancel_request(client, request_id);
                continue;
            }
            if (type != "request")
                break;
            const auto method = message.value("method", std::string{});
            if (method.starts_with("owner-") || method.starts_with("disposable-"))
                native_boundary_calls_.fetch_add(1);
            if (!method.starts_with("owner-"))
                touch();
            if (method == "status") {
                client->send(result_event_json(request_id, true, status_json().dump()));
                continue;
            }
            if (method == "stop") {
                begin_drain();
                wait_for_drain();
                finish_if_safe();
                client->send(result_event_json(request_id, true, status_json().dump()));
                break;
            }
            const auto message_payload = message.value("payload", Json::object());
            if (method == "owner-next") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "owner-next requires ownerWorkerId"));
                    continue;
                }
                const auto result =
                    take_owner_request(message_payload["ownerWorkerId"].get<std::uint64_t>());
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-complete") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "owner-complete requires worker and token"));
                    continue;
                }
                const auto result =
                    complete_owner_request(message_payload["ownerWorkerId"].get<std::uint64_t>(),
                                           message_payload["token"].get<std::uint64_t>(),
                                           message_payload.value("requestOk", false),
                                           message_payload.value("result", Json(nullptr)),
                                           message_payload.value("error", std::string{}));
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-validation-result") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned() ||
                    !message_payload.contains("semanticKey") ||
                    !message_payload["semanticKey"].is_string() ||
                    !message_payload.contains("validationResult") ||
                    !message_payload.contains("humanResult") ||
                    !message_payload.contains("jsonResult")) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "owner-validation-result requires worker, "
                                                   "token, semantic key, and result"));
                    continue;
                }
                const auto result = retain_owner_validation_result(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(),
                    message_payload["token"].get<std::uint64_t>(),
                    message_payload["semanticKey"].get<std::string>(),
                    message_payload["validationResult"], message_payload["humanResult"],
                    message_payload["jsonResult"]);
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-cancelled") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "owner-cancelled requires worker and token"));
                    continue;
                }
                const auto result =
                    owner_cancellation_status(message_payload["ownerWorkerId"].get<std::uint64_t>(),
                                              message_payload["token"].get<std::uint64_t>());
                client->send(result_event_json(request_id, true, result.dump()));
                continue;
            }
            if (method == "owner-needs-reconcile" || method == "owner-reconcile-complete") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "Project-owner maintenance requires worker"));
                    continue;
                }
                const auto owner_worker_id = message_payload["ownerWorkerId"].get<std::uint64_t>();
                Json result;
                if (method == "owner-needs-reconcile") {
                    result = owner_reconciliation_status(owner_worker_id);
                } else {
                    result = complete_owner_reconciliation(
                        owner_worker_id, message_payload.value("advanced", false));
                }
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-event") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned() ||
                    !message_payload.contains("event") || !message_payload["event"].is_object()) {
                    client->send(
                        result_event_json(request_id, false, "null",
                                          "owner-event requires worker, token, and event"));
                    continue;
                }
                const auto result = emit_owner_request_event(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(),
                    message_payload["token"].get<std::uint64_t>(), message_payload["event"]);
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-enter-critical" || method == "owner-leave-critical") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned()) {
                    client->send(
                        result_event_json(request_id, false, "null",
                                          "Project-owner critical request requires worker"));
                    continue;
                }
                const auto owner_worker_id = message_payload["ownerWorkerId"].get<std::uint64_t>();
                const auto result = method == "owner-enter-critical"
                                        ? enter_owner_critical_section(owner_worker_id)
                                        : leave_owner_critical_section(owner_worker_id);
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-project-sessions") {
                client->send(result_event_json(request_id, true, status_json().dump()));
                continue;
            }
            if (method == "owner-project-observe") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "Project-owner observation requires worker"));
                    continue;
                }
                std::string authority_error;
                const auto authority_request =
                    parse_project_authority_request(message_payload, authority_error);
                if (!authority_request) {
                    client->send(result_event_json(request_id, false, "null", authority_error));
                    continue;
                }
                try {
                    const auto observation = observe_owner_project(
                        message_payload["ownerWorkerId"].get<std::uint64_t>(), *authority_request);
                    const auto result = project_observation_json(observation);
                    client->send(result_event_json(request_id, true, result.dump()));
                } catch (const std::exception& error) {
                    client->send(result_event_json(request_id, false, "null", error.what()));
                }
                continue;
            }
            if (method == "owner-project-release") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("projectRoot") ||
                    !message_payload["projectRoot"].is_string()) {
                    client->send(
                        result_event_json(request_id, false, "null",
                                          "Project-owner release requires worker and root"));
                    continue;
                }
#if defined(_WIN32)
                const std::filesystem::path root =
                    utf8_to_wide(message_payload["projectRoot"].get_ref<const std::string&>());
#else
                const std::filesystem::path root =
                    message_payload["projectRoot"].get<std::string>();
#endif
                const auto released = release_owner_project(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(), root);
                const Json result = {{"ok", true}, {"released", released}};
                client->send(result_event_json(request_id, true, result.dump()));
                continue;
            }
            if (method == "owner-project-generation") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("sessionEpoch") ||
                    !message_payload["sessionEpoch"].is_number_unsigned() ||
                    !message_payload.contains("generation") ||
                    !message_payload["generation"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "resident Project generation is malformed"));
                    continue;
                }
                const auto result = declare_owner_generation(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(),
                    ProjectGenerationIdentity{
                        .session_epoch = message_payload["sessionEpoch"].get<std::uint64_t>(),
                        .generation = message_payload["generation"].get<std::uint64_t>(),
                    });
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-snapshot-begin") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("sessionEpoch") ||
                    !message_payload["sessionEpoch"].is_number_unsigned() ||
                    !message_payload.contains("generation") ||
                    !message_payload["generation"].is_number_unsigned() ||
                    !message_payload.contains("ownerMetadata") ||
                    !message_payload["ownerMetadata"].is_string()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "portable Project snapshot begin is malformed"));
                    continue;
                }
                const auto result = begin_owner_snapshot(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(),
                    ProjectGenerationIdentity{
                        .session_epoch = message_payload["sessionEpoch"].get<std::uint64_t>(),
                        .generation = message_payload["generation"].get<std::uint64_t>(),
                    },
                    message_payload["ownerMetadata"].get<std::string>());
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-snapshot-chunk") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("chunk") || !message_payload["chunk"].is_string()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "portable Project snapshot chunk is malformed"));
                    continue;
                }
                const auto result = append_owner_snapshot_chunk(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(),
                    message_payload["chunk"].get<std::string>());
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-snapshot-commit" || method == "owner-snapshot-describe") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned()) {
                    client->send(
                        result_event_json(request_id, false, "null",
                                          "portable Project snapshot request requires worker"));
                    continue;
                }
                const auto owner_worker_id = message_payload["ownerWorkerId"].get<std::uint64_t>();
                const auto result = method == "owner-snapshot-commit"
                                        ? commit_owner_snapshot(owner_worker_id)
                                        : describe_owner_snapshot(owner_worker_id);
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "owner-snapshot-read") {
                if (!message_payload.contains("ownerWorkerId") ||
                    !message_payload["ownerWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("sessionEpoch") ||
                    !message_payload["sessionEpoch"].is_number_unsigned() ||
                    !message_payload.contains("generation") ||
                    !message_payload["generation"].is_number_unsigned() ||
                    !message_payload.contains("index") ||
                    !message_payload["index"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "portable Project snapshot read is malformed"));
                    continue;
                }
                const auto result = read_owner_snapshot_chunk(
                    message_payload["ownerWorkerId"].get<std::uint64_t>(),
                    ProjectGenerationIdentity{
                        .session_epoch = message_payload["sessionEpoch"].get<std::uint64_t>(),
                        .generation = message_payload["generation"].get<std::uint64_t>(),
                    },
                    message_payload["index"].get<std::size_t>());
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "disposable-ready" || method == "disposable-next") {
                if (!message_payload.contains("disposableWorkerId") ||
                    !message_payload["disposableWorkerId"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "disposable worker request requires worker"));
                    continue;
                }
                const auto worker_id = message_payload["disposableWorkerId"].get<std::uint64_t>();
                const auto result = method == "disposable-ready"
                                        ? mark_disposable_ready(worker_id)
                                        : take_disposable_request(worker_id);
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "disposable-cancelled") {
                if (!message_payload.contains("disposableWorkerId") ||
                    !message_payload["disposableWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "disposable cancellation request is malformed"));
                    continue;
                }
                const auto result = disposable_cancellation_status(
                    message_payload["disposableWorkerId"].get<std::uint64_t>(),
                    message_payload["token"].get<std::uint64_t>());
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "disposable-event") {
                if (!message_payload.contains("disposableWorkerId") ||
                    !message_payload["disposableWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned() ||
                    !message_payload.contains("event") || !message_payload["event"].is_object()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "disposable event request is malformed"));
                    continue;
                }
                const auto result = emit_disposable_request_event(
                    message_payload["disposableWorkerId"].get<std::uint64_t>(),
                    message_payload["token"].get<std::uint64_t>(), message_payload["event"]);
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "disposable-snapshot-read") {
                if (!message_payload.contains("disposableWorkerId") ||
                    !message_payload["disposableWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned() ||
                    !message_payload.contains("index") ||
                    !message_payload["index"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "disposable snapshot request is malformed"));
                    continue;
                }
                const auto result = read_disposable_snapshot_chunk(
                    message_payload["disposableWorkerId"].get<std::uint64_t>(),
                    message_payload["token"].get<std::uint64_t>(),
                    message_payload["index"].get<std::size_t>());
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "disposable-complete") {
                if (!message_payload.contains("disposableWorkerId") ||
                    !message_payload["disposableWorkerId"].is_number_unsigned() ||
                    !message_payload.contains("token") ||
                    !message_payload["token"].is_number_unsigned()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "disposable completion request is malformed"));
                    continue;
                }
                const auto result = complete_disposable_request(
                    message_payload["disposableWorkerId"].get<std::uint64_t>(),
                    message_payload["token"].get<std::uint64_t>(),
                    message_payload.value("requestOk", false),
                    message_payload.value("result", Json()),
                    message_payload.value("error", std::string{}));
                client->send(result_event_json(request_id, result.value("ok", false), result.dump(),
                                               result.value("error", std::string{})));
                continue;
            }
            if (method == "invoke") {
                if (!message_payload.is_object() || !message_payload.contains("executionClass") ||
                    !message_payload["executionClass"].is_string()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "daemon execution class is malformed"));
                    continue;
                }
                const auto execution_class =
                    message_payload["executionClass"].get_ref<const std::string&>();
                if (execution_class != "owner-short" && execution_class != "owner-mutation" &&
                    execution_class != "disposable-heavy") {
                    client->send(result_event_json(request_id, false, "null",
                                                   "daemon execution class is unsupported"));
                    continue;
                }
            }
            if (method == "invoke" && message_payload.is_object() &&
                message_payload.contains("ownerProjectRoot") &&
                !message_payload["ownerProjectRoot"].is_null()) {
                const auto routed =
                    queue_project_owner_request(client, request_id, method, message_payload);
                if (!routed)
                    continue;
                if (!routed->empty()) {
                    client->send(result_event_json(request_id, false, "null", *routed));
                    continue;
                }
            }
            if (method == "invoke") {
                const auto routed =
                    queue_disposable_request(client, request_id, method, message_payload);
                if (!routed)
                    continue;
                client->send(result_event_json(request_id, false, "null", *routed));
                continue;
            }
            if (state_.load() == State::draining || state_.load() == State::stopped) {
                client->send(result_event_json(request_id, false, "null", "daemon is draining"));
                continue;
            }
            if (state_.load() == State::starting) {
                std::scoped_lock lock(queue_mutex_);
                const auto duplicate =
                    std::find_if(queued_.begin(), queued_.end(), [&](const QueuedRequest& queued) {
                        return queued.request_id == request_id && queued.client.lock() == client;
                    });
                if (duplicate != queued_.end()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "duplicate pending daemon request id"));
                } else {
                    queued_.push_back(QueuedRequest{
                        .client = client,
                        .request_id = request_id,
                        .method = method,
                        .payload = message.value("payload", Json::object()),
                        .prepare_disposable = false,
                    });
                    queue_cv_.notify_one();
                }
                continue;
            }
            {
                std::scoped_lock lock(queue_mutex_);
                const auto duplicate =
                    std::find_if(queued_.begin(), queued_.end(), [&](const QueuedRequest& queued) {
                        return queued.request_id == request_id && queued.client.lock() == client;
                    });
                if (duplicate != queued_.end()) {
                    client->send(result_event_json(request_id, false, "null",
                                                   "duplicate pending daemon request id"));
                } else {
                    queued_.push_back(QueuedRequest{
                        .client = client,
                        .request_id = request_id,
                        .method = method,
                        .payload = message.value("payload", Json::object()),
                        .prepare_disposable = false,
                    });
                    queue_cv_.notify_one();
                }
            }
        }
        cancel_client_requests(client);
        client->close();
    }

    void cancel_request(const std::shared_ptr<ClientConnection>& client,
                        const std::string& request_id)
    {
        bool removed = false;
        {
            std::scoped_lock lock(queue_mutex_);
            const auto found =
                std::find_if(queued_.begin(), queued_.end(), [&](const QueuedRequest& queued) {
                    return queued.request_id == request_id && queued.client.lock() == client;
                });
            if (found != queued_.end()) {
                queued_.erase(found);
                removed = true;
            }
            if (!removed) {
                for (auto& [id, owner] : project_owners_) {
                    (void)id;
                    const auto owner_found = std::find_if(
                        owner.queued.begin(), owner.queued.end(), [&](const QueuedRequest& queued) {
                            return queued.request_id == request_id &&
                                   queued.client.lock() == client;
                        });
                    if (owner_found == owner.queued.end())
                        continue;
                    owner.queued.erase(owner_found);
                    removed = true;
                    break;
                }
            }
            if (!removed) {
                const auto prepared =
                    std::find_if(prepared_disposable_.begin(), prepared_disposable_.end(),
                                 [&](const PreparedDisposableRequest& request) {
                                     return request.request.request_id == request_id &&
                                            request.request.client.lock() == client;
                                 });
                if (prepared != prepared_disposable_.end()) {
                    if (prepared->identity)
                        (void)project_snapshots_.unpin(prepared->canonical_root,
                                                       *prepared->identity, now_millis());
                    prepared_disposable_.erase(prepared);
                    removed = true;
                }
            }
            if (!removed) {
                for (auto& [id, worker] : disposable_workers_) {
                    (void)id;
                    if (!worker.assignment || worker.assignment->request.request_id != request_id ||
                        worker.assignment->request.client.lock() != client)
                        continue;
                    if (worker.assignment->identity)
                        (void)project_snapshots_.unpin(worker.assignment->canonical_root,
                                                       *worker.assignment->identity, now_millis());
                    worker.assignment.reset();
                    worker.state = DisposableWorkerState::retiring;
                    removed = true;
                    disposable_cv_.notify_all();
                    break;
                }
            }
        }
        if (removed) {
            Json event =
                Json::parse(result_event_json(request_id, false, "null", "request cancelled"));
            event["cancelled"] = true;
            client->send(event.dump());
            return;
        }
        std::scoped_lock lock(queue_mutex_);
        for (auto& [token, active] : active_) {
            (void)token;
            if (active.request_id == request_id && active.client.lock() == client) {
                active.cancelled = true;
                if (active.cancellation_requested_millis == 0)
                    active.cancellation_requested_millis = now_millis();
                break;
            }
        }
    }

    void cancel_client_requests(const std::shared_ptr<ClientConnection>& client)
    {
        std::scoped_lock lock(queue_mutex_);
        queued_.erase(std::remove_if(queued_.begin(), queued_.end(),
                                     [&](const QueuedRequest& queued) {
                                         return queued.client.lock() == client;
                                     }),
                      queued_.end());
        for (auto& [id, owner] : project_owners_) {
            (void)id;
            owner.queued.erase(std::remove_if(owner.queued.begin(), owner.queued.end(),
                                              [&](const QueuedRequest& queued) {
                                                  return queued.client.lock() == client;
                                              }),
                               owner.queued.end());
        }
        std::erase_if(prepared_disposable_, [&](const PreparedDisposableRequest& prepared) {
            if (prepared.request.client.lock() != client)
                return false;
            if (prepared.identity)
                (void)project_snapshots_.unpin(prepared.canonical_root, *prepared.identity,
                                               now_millis());
            return true;
        });
        for (auto& [id, worker] : disposable_workers_) {
            (void)id;
            if (!worker.assignment || worker.assignment->request.client.lock() != client)
                continue;
            if (worker.assignment->identity)
                (void)project_snapshots_.unpin(worker.assignment->canonical_root,
                                               *worker.assignment->identity, now_millis());
            worker.assignment.reset();
            worker.state = DisposableWorkerState::retiring;
        }
        for (auto& [token, active] : active_) {
            (void)token;
            if (active.client.lock() == client) {
                active.cancelled = true;
                if (active.cancellation_requested_millis == 0)
                    active.cancellation_requested_millis = now_millis();
            }
        }
        disposable_cv_.notify_all();
    }

    void cancel_queued(std::string_view reason)
    {
        std::vector<QueuedRequest> queued;
        std::vector<PreparedDisposableRequest> prepared;
        {
            std::scoped_lock lock(queue_mutex_);
            queued.swap(queued_);
            for (auto& [id, owner] : project_owners_) {
                (void)id;
                queued.insert(queued.end(), std::make_move_iterator(owner.queued.begin()),
                              std::make_move_iterator(owner.queued.end()));
                owner.queued.clear();
            }
            prepared.swap(prepared_disposable_);
            for (auto& [id, worker] : disposable_workers_) {
                (void)id;
                if (!worker.assignment)
                    continue;
                prepared.push_back(std::move(*worker.assignment));
                worker.assignment.reset();
                worker.state = DisposableWorkerState::retiring;
            }
        }
        for (const auto& request : queued) {
            if (const auto client = request.client.lock()) {
                Json event =
                    Json::parse(result_event_json(request.request_id, false, "null", reason));
                event["cancelled"] = true;
                client->send(event.dump());
            }
        }
        for (const auto& request : prepared) {
            if (request.identity)
                (void)project_snapshots_.unpin(request.canonical_root, *request.identity,
                                               now_millis());
            if (const auto client = request.request.client.lock()) {
                Json event = Json::parse(
                    result_event_json(request.request.request_id, false, "null", reason));
                event["cancelled"] = true;
                client->send(event.dump());
            }
        }
        {
            std::scoped_lock lock(queue_mutex_);
            for (auto& [token, active] : active_) {
                (void)token;
                active.cancelled = true;
                if (active.cancellation_requested_millis == 0)
                    active.cancellation_requested_millis = now_millis();
            }
        }
        queue_cv_.notify_all();
        owner_cv_.notify_all();
        disposable_cv_.notify_all();
    }

    void begin_drain()
    {
        const auto prior = state_.exchange(State::draining);
        if (prior == State::stopped)
            return;
        cancel_queued("daemon is draining");
        stop_accepting();
    }

    void wait_for_drain()
    {
        for (;;) {
            {
                std::unique_lock lock(queue_mutex_);
                if (active_.empty() && exact_validation_probes_.load() == 0)
                    break;
                active_cv_.wait_for(lock, std::chrono::milliseconds(50));
            }
            maintain_project_owners();
            maintain_disposable_workers();
        }
        for (;;) {
            {
                std::unique_lock lock(critical_mutex_);
                if (critical_sections_.load() == 0)
                    break;
                critical_cv_.wait_for(lock, std::chrono::milliseconds(50));
            }
            maintain_project_owners();
            maintain_disposable_workers();
        }
    }

    void request_stop()
    {
        begin_drain();
        if (state_.load() == State::stopped)
            return;
        wait_for_drain();
        finish_if_safe();
        close_clients();
    }

    void finish_if_safe()
    {
        if (state_.load() != State::draining || critical_sections_.load() != 0 ||
            exact_validation_probes_.load() != 0)
            return;
        {
            std::scoped_lock lock(queue_mutex_);
            if (!queued_.empty() || !active_.empty())
                return;
        }
        State expected = State::draining;
        if (!state_.compare_exchange_strong(expected, State::stopped))
            return;
        retire_all_disposable_workers("daemon is stopping");
        retire_all_project_owners("daemon is stopping");
#if !defined(_WIN32)
        std::error_code error;
        std::filesystem::remove(endpoint_.socket_path, error);
#endif
        release_lifetime_ownership();
        state_cv_.notify_all();
    }

    void stop_accepting()
    {
        std::scoped_lock lock(listener_mutex_);
#if defined(_WIN32)
        if (pending_pipe_ != invalid_connection) {
            CancelIoEx(pending_pipe_, nullptr);
            CloseHandle(pending_pipe_);
            pending_pipe_ = invalid_connection;
        }
#else
        if (listener_ >= 0) {
            ::shutdown(listener_, SHUT_RDWR);
            ::close(listener_);
            listener_ = -1;
        }
#endif
    }

    void release_lifetime_ownership()
    {
        std::scoped_lock lock(listener_mutex_);
#if defined(_WIN32)
        if (lifetime_mutex_ != nullptr) {
            if (lifetime_mutex_owned_)
                ReleaseMutex(lifetime_mutex_);
            CloseHandle(lifetime_mutex_);
            lifetime_mutex_ = nullptr;
            lifetime_mutex_owned_ = false;
        }
#else
        if (lifetime_lock_ >= 0) {
            ::flock(lifetime_lock_, LOCK_UN);
            ::close(lifetime_lock_);
            lifetime_lock_ = -1;
        }
#endif
    }

    void close_listener()
    {
        stop_accepting();
        release_lifetime_ownership();
    }

    void close_clients()
    {
        std::vector<std::shared_ptr<ClientConnection>> clients;
        {
            std::scoped_lock lock(clients_mutex_);
            clients.assign(clients_.begin(), clients_.end());
        }
        for (const auto& client : clients)
            client->close();
    }

    void idle_loop()
    {
        const auto sleep_interval = std::chrono::milliseconds(
            std::max<std::uint64_t>(10, std::min<std::uint64_t>(250, context_.daemon_idle_ms / 4)));
        while (state_.load() != State::stopped && state_.load() != State::draining) {
            std::this_thread::sleep_for(sleep_interval);
            maintain_project_owners();
            maintain_disposable_workers();
            if (critical_sections_.load() != 0 || exact_validation_probes_.load() != 0)
                continue;
            {
                std::scoped_lock lock(queue_mutex_);
                const bool owner_work_pending = std::any_of(
                    project_owners_.begin(), project_owners_.end(), [](const auto& item) {
                        const auto& owner = item.second;
                        return !owner.queued.empty() || owner.dispatching || owner.reconciling;
                    });
                if (!queued_.empty() || !active_.empty() || owner_work_pending)
                    continue;
            }
            publish_pending_validation_cache();
            const auto elapsed = now_millis() - last_activity_millis_.load();
            if (elapsed >= context_.daemon_idle_ms) {
                request_stop();
                break;
            }
        }
    }

    void join_threads()
    {
        const auto current = std::this_thread::get_id();
        if (listener_thread_.joinable() && listener_thread_.get_id() != current)
            listener_thread_.join();
        if (idle_thread_.joinable() && idle_thread_.get_id() != current)
            idle_thread_.join();
        std::vector<std::thread> clients;
        {
            std::scoped_lock lock(clients_mutex_);
            clients.swap(client_threads_);
        }
        for (auto& thread : clients)
            if (thread.joinable() && thread.get_id() != current)
                thread.join();
    }

    BrokerContext context_;
    Endpoint endpoint_;
    std::atomic<State> state_{State::stopped};
    std::atomic<std::uint64_t> last_activity_millis_{0};
    std::atomic<std::uint64_t> critical_sections_{0};
    std::atomic<std::uint64_t> exact_validation_probes_{0};
    std::atomic<std::uint64_t> generic_project_sessions_{0};
    std::atomic<std::uint64_t> authority_observations_{0};
    std::atomic<std::uint64_t> files_observed_{0};
    std::atomic<std::uint64_t> changed_paths_{0};
    std::atomic<std::uint64_t> native_boundary_calls_{0};
    std::atomic<std::uint64_t> owner_spawns_{0};
    std::atomic<std::uint64_t> owner_cold_admissions_{0};
    std::atomic<std::uint64_t> owner_rehydrations_{0};
    std::atomic<std::uint64_t> exact_result_hits_{0};
    std::atomic<std::uint64_t> generation_promotions_{0};
    std::atomic<std::uint64_t> snapshot_publications_{0};
    std::atomic<std::uint64_t> snapshot_handoffs_{0};
    std::atomic<std::uint64_t> disposable_spawns_{0};
    std::atomic<std::uint64_t> disposable_queues_{0};
    std::atomic<std::uint64_t> owner_retirements_{0};
    std::atomic<std::uint64_t> disposable_retirements_{0};
    ProjectAuthorityManager project_authority_;
    ProjectSnapshotStore project_snapshots_;
    std::mutex validation_mutex_;
    std::unordered_map<std::string, ExactValidationResult> exact_validation_results_;
    std::unordered_map<std::string, ExactValidationResult> pending_validation_publications_;
    std::atomic<std::uint64_t> next_validation_revision_{1};
    std::mutex critical_mutex_;
    std::condition_variable critical_cv_;
    mutable std::mutex state_mutex_;
    std::condition_variable state_cv_;
    mutable std::mutex queue_mutex_;
    std::condition_variable queue_cv_;
    std::condition_variable owner_cv_;
    std::condition_variable disposable_cv_;
    std::condition_variable active_cv_;
    std::vector<QueuedRequest> queued_;
    std::unordered_map<std::uint64_t, ActiveRequest> active_;
    std::atomic<std::uint64_t> next_request_token_{1};
    std::unordered_map<std::uint64_t, ProjectOwnerWorker> project_owners_;
    std::unordered_map<std::string, std::uint64_t> project_owner_by_root_;
    std::unordered_set<std::string> exact_validation_probe_roots_;
    std::atomic<std::uint64_t> next_owner_worker_id_{1};
    std::unordered_map<std::uint64_t, DisposableWorker> disposable_workers_;
    std::vector<PreparedDisposableRequest> prepared_disposable_;
    std::atomic<std::uint64_t> next_disposable_worker_id_{1};
    std::atomic<std::uint64_t> next_project_session_epoch_{1};
    std::mutex clients_mutex_;
    std::unordered_set<std::shared_ptr<ClientConnection>> clients_;
    std::vector<std::thread> client_threads_;
    std::mutex listener_mutex_;
#if defined(_WIN32)
    ConnectionHandle pending_pipe_ = invalid_connection;
    HANDLE lifetime_mutex_ = nullptr;
    bool lifetime_mutex_owned_ = false;
#else
    int listener_ = -1;
    int lifetime_lock_ = -1;
#endif
    std::thread listener_thread_;
    std::thread idle_thread_;
};

std::mutex server_mutex;
std::shared_ptr<BrokerServer> local_server;

ConnectionHandle connect_endpoint(const Endpoint& endpoint, IoDeadline deadline = std::nullopt)
{
#if defined(_WIN32)
    DWORD wait_timeout = 100;
    if (deadline) {
        const auto remaining = remaining_millis(*deadline);
        if (remaining == 0)
            return invalid_connection;
        wait_timeout = static_cast<DWORD>(
            std::min<std::uint64_t>(remaining, static_cast<std::uint64_t>(INFINITE - 1)));
    }
    if (!WaitNamedPipeW(endpoint.pipe_name.c_str(), wait_timeout))
        return invalid_connection;
    const auto flags = deadline ? FILE_FLAG_OVERLAPPED : 0;
    const auto pipe = CreateFileW(endpoint.pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                                  nullptr, OPEN_EXISTING, flags, nullptr);
    return pipe == INVALID_HANDLE_VALUE ? invalid_connection : pipe;
#else
    const auto socket = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (socket < 0)
        return invalid_connection;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const auto socket_text = endpoint.socket_path.string();
    std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
    if (!deadline) {
        if (::connect(socket, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0) {
            ::close(socket);
            return invalid_connection;
        }
        return socket;
    }
    const auto flags = ::fcntl(socket, F_GETFL, 0);
    if (flags < 0 || ::fcntl(socket, F_SETFL, flags | O_NONBLOCK) != 0) {
        ::close(socket);
        return invalid_connection;
    }
    if (::connect(socket, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) == 0)
        return socket;
    if (errno != EINPROGRESS || !wait_for_socket(socket, POLLOUT, *deadline)) {
        ::close(socket);
        return invalid_connection;
    }
    int error = 0;
    socklen_t error_size = sizeof(error);
    if (::getsockopt(socket, SOL_SOCKET, SO_ERROR, &error, &error_size) != 0 || error != 0) {
        ::close(socket);
        return invalid_connection;
    }
    return socket;
#endif
}

Json client_request(const BrokerContext& context, std::string_view method, std::string request_id,
                    Json request_payload = Json::object(),
                    std::optional<std::uint64_t> cancel_after_ms = std::nullopt,
                    IoDeadline deadline = std::nullopt)
{
    ClientInterruptScope interrupt_scope(method == "invoke");
    Endpoint endpoint;
    try {
        endpoint = make_endpoint(context);
    } catch (const std::exception& error) {
        return {{"ok", false}, {"error", error.what()}};
    }
    const auto connection = connect_endpoint(endpoint, deadline);
    if (connection == invalid_connection) {
        if (method == "status")
            return {{"ok", true},
                    {"running", false},
                    {"state", "stopped"},
                    {"build", context.build},
                    {"protocol", context.protocol},
                    {"pid", nullptr}};
        if (method == "stop")
            return {{"ok", true},
                    {"running", false},
                    {"state", "stopped"},
                    {"build", context.build},
                    {"protocol", context.protocol},
                    {"pid", nullptr}};
        return {{"ok", false}, {"error", "daemon broker is not reachable"}};
    }
    const Json request = {{"type", "request"},
                          {"requestId", request_id},
                          {"method", std::string(method)},
                          {"payload", std::move(request_payload)}};
    if (!send_payload(connection, request.dump(), deadline)) {
        close_outbound_connection(connection);
        return {{"ok", false}, {"error", "failed to send daemon request"}};
    }
    std::optional<std::jthread> interrupt_watcher;
    if (interrupt_scope.enabled()) {
        interrupt_watcher.emplace([connection, request_id](std::stop_token stop_token) {
            while (!stop_token.stop_requested()) {
                if (client_interrupt_signal != 0) {
                    const auto cancel_deadline = Clock::now() + std::chrono::milliseconds(250);
                    (void)send_payload(connection, cancellation_event_json(request_id),
                                       cancel_deadline);
                    return;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
            }
        });
    }
    if (cancel_after_ms) {
        std::this_thread::sleep_for(std::chrono::milliseconds(*cancel_after_ms));
        if (!send_payload(connection, cancellation_event_json(request_id), deadline)) {
            close_outbound_connection(connection);
            return {{"ok", false}, {"error", "failed to send daemon cancellation"}};
        }
    }
    for (;;) {
        const auto response = receive_payload(connection, deadline);
        if (!response) {
            close_outbound_connection(connection);
            return {{"ok", false}, {"error", "daemon broker closed without a result"}};
        }
        auto event = Json::parse(*response, nullptr, false);
        if (event.is_discarded() || event.value("requestId", std::string{}) != request_id) {
            close_outbound_connection(connection);
            return {{"ok", false}, {"error", "daemon broker returned an invalid result frame"}};
        }
        const auto type = event.value("type", std::string{});
        if (type == "stdout" || type == "stderr") {
            if (!event.contains("text") || !event["text"].is_string()) {
                close_outbound_connection(connection);
                return {{"ok", false}, {"error", "daemon broker returned an invalid text frame"}};
            }
            const auto& text = event["text"].get_ref<const std::string&>();
            auto* stream = type == "stdout" ? stdout : stderr;
            if (!text.empty()) {
                std::fwrite(text.data(), 1, text.size(), stream);
                std::fflush(stream);
            }
            continue;
        }
        if (type == "progress") {
            if (!event.contains("message") || !event["message"].is_string()) {
                close_outbound_connection(connection);
                return {{"ok", false},
                        {"error", "daemon broker returned an invalid progress frame"}};
            }
            const auto& message = event["message"].get_ref<const std::string&>();
            if (!message.empty()) {
                std::fwrite(message.data(), 1, message.size(), stderr);
                if (message.back() != '\n')
                    std::fputc('\n', stderr);
                std::fflush(stderr);
            }
            continue;
        }
        if (type != "result") {
            close_outbound_connection(connection);
            return {{"ok", false}, {"error", "daemon broker returned an invalid result frame"}};
        }
        close_outbound_connection(connection);
        if ((method == "status" || method == "stop") && event.value("ok", false) &&
            event.contains("result") && event["result"].is_object())
            return event["result"];
        return event;
    }
}

Json start_local_server(const BrokerContext& context)
{
    std::scoped_lock lock(server_mutex);
    if (local_server)
        return {{"ok", false}, {"error", "daemon broker is already running in this process"}};
    try {
        auto server = std::make_shared<BrokerServer>(context, make_endpoint(context));
        auto result = server->start();
        local_server = std::move(server);
        return result;
    } catch (const std::exception& error) {
        return {{"ok", false}, {"error", error.what()}};
    }
}

Json mark_local_ready()
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    return server ? server->mark_ready()
                  : Json{{"ok", false}, {"error", "daemon broker is not running in this process"}};
}

Json take_local_request()
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    return server ? server->take_next_request()
                  : Json{{"ok", false}, {"error", "daemon broker is not running in this process"}};
}

Json complete_local_request(const Json& request)
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    if (!request.contains("token") || !request["token"].is_number_unsigned())
        return {{"ok", false}, {"error", "daemon completion requires request token"}};
    return server->complete_request(
        request["token"].get<std::uint64_t>(), request.value("requestOk", false),
        request.value("result", Json(nullptr)), request.value("error", std::string{}));
}

Json emit_local_request_event(const Json& request)
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    if (!request.contains("token") || !request["token"].is_number_unsigned())
        return {{"ok", false}, {"error", "daemon event requires request token"}};
    if (!request.contains("event") || !request["event"].is_object())
        return {{"ok", false}, {"error", "daemon event requires event payload"}};
    return server->emit_request_event(request["token"].get<std::uint64_t>(), request["event"]);
}

Json local_cancellation_status(const Json& request)
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    if (!request.contains("token") || !request["token"].is_number_unsigned())
        return {{"ok", false}, {"error", "daemon cancellation probe requires request token"}};
    return server->cancellation_status(request["token"].get<std::uint64_t>());
}

Json enter_local_critical_section()
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    return server ? server->enter_critical_section()
                  : Json{{"ok", false}, {"error", "daemon broker is not running in this process"}};
}

Json leave_local_critical_section()
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    return server ? server->leave_critical_section()
                  : Json{{"ok", false}, {"error", "daemon broker is not running in this process"}};
}

Json set_local_project_session_count(const Json& request)
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    if (!request.contains("projectSessions") || !request["projectSessions"].is_number_unsigned())
        return {{"ok", false}, {"error", "daemon project session update requires projectSessions"}};
    return server->set_project_session_count(request["projectSessions"].get<std::uint64_t>());
}

bool parse_string_array(const Json& object, std::string_view field,
                        std::vector<std::string>& output, std::string& error, bool required = true)
{
    const auto found = object.find(std::string(field));
    if (found == object.end()) {
        if (!required)
            return true;
        error = std::string(field) + " is required";
        return false;
    }
    if (!found->is_array()) {
        error = std::string(field) + " must be an array";
        return false;
    }
    output.clear();
    output.reserve(found->size());
    for (const auto& value : *found) {
        if (!value.is_string()) {
            error = std::string(field) + " must contain only strings";
            return false;
        }
        output.push_back(value.get<std::string>());
    }
    return true;
}

std::optional<ProjectAuthorityRequest> parse_project_authority_request(const Json& request,
                                                                       std::string& error)
{
    if (!request.contains("projectRoot") || !request["projectRoot"].is_string() ||
        request["projectRoot"].get_ref<const std::string&>().empty()) {
        error = "Project authority observation requires projectRoot";
        return std::nullopt;
    }

    ProjectAuthorityRequest result;
#if defined(_WIN32)
    result.project_root = utf8_to_wide(request["projectRoot"].get_ref<const std::string&>());
#else
    result.project_root = request["projectRoot"].get<std::string>();
#endif
    if (!parse_string_array(request, "authoritativePaths", result.authoritative_paths, error))
        return std::nullopt;

    if (request.contains("discoveryScopes")) {
        if (!request["discoveryScopes"].is_array()) {
            error = "discoveryScopes must be an array";
            return std::nullopt;
        }
        for (const auto& encoded_scope : request["discoveryScopes"]) {
            if (!encoded_scope.is_object() || !encoded_scope.contains("root") ||
                !encoded_scope["root"].is_string() ||
                encoded_scope["root"].get_ref<const std::string&>().empty()) {
                error = "Each Project discovery scope requires a non-empty root";
                return std::nullopt;
            }
            ProjectSourceDiscoveryScope scope;
            scope.root = encoded_scope["root"].get<std::string>();
            if (!parse_string_array(encoded_scope, "extensions", scope.extensions, error))
                return std::nullopt;
            if (!parse_string_array(encoded_scope, "excludedPrefixes", scope.excluded_prefixes,
                                    error, false))
                return std::nullopt;
            result.discovery_scopes.push_back(std::move(scope));
        }
    }
    return result;
}

Json project_manifest_json(const ProjectSourceManifest& manifest)
{
    Json entries = Json::array();
    for (const auto& entry : manifest.entries) {
        Json encoded = {{"path", entry.path},
                        {"sourceIdentity", entry.source_identity},
                        {"byteSize", entry.byte_size}};
        if (entry.mtime_nanoseconds)
            encoded["mtimeNanoseconds"] = std::to_string(*entry.mtime_nanoseconds);
        else
            encoded["mtimeNanoseconds"] = nullptr;
        if (entry.content_hash)
            encoded["contentHash"] = *entry.content_hash;
        entries.push_back(std::move(encoded));
    }
    return {{"canonicalRoot", manifest.canonical_root}, {"entries", std::move(entries)}};
}

Json project_observation_json(const ProjectObservation& observation)
{
    return {{"ok", true},
            {"authority", "proven"},
            {"previousAuthority", project_authority_state_name(observation.previous_state)},
            {"unchanged", observation.unchanged},
            {"fullRescan", observation.full_rescan},
            {"watcherPaths", observation.watcher_paths},
            {"delta",
             {{"added", observation.delta.added},
              {"changed", observation.delta.changed},
              {"removed", observation.delta.removed}}},
            {"manifest", project_manifest_json(observation.manifest)}};
}

Json observe_local_project(const Json& request)
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    std::string error;
    const auto authority_request = parse_project_authority_request(request, error);
    if (!authority_request)
        return {{"ok", false}, {"error", std::move(error)}};
    try {
        return project_observation_json(server->observe_project(*authority_request));
    } catch (const std::exception& exception) {
        return {{"ok", false}, {"error", exception.what()}};
    }
}

Json release_local_project(const Json& request)
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    if (!request.contains("projectRoot") || !request["projectRoot"].is_string() ||
        request["projectRoot"].get_ref<const std::string&>().empty())
        return {{"ok", false}, {"error", "Project authority release requires projectRoot"}};
#if defined(_WIN32)
    const std::filesystem::path root =
        utf8_to_wide(request["projectRoot"].get_ref<const std::string&>());
#else
    const std::filesystem::path root = request["projectRoot"].get<std::string>();
#endif
    return {{"ok", true}, {"released", server->release_project(root)}};
}

Json start_local_interrupt_scope()
{
    std::scoped_lock lock(local_interrupt_scope_mutex);
    if (!local_interrupt_scope_active) {
        acquire_client_interrupt_handler();
        local_interrupt_scope_active = true;
    }
    return {{"ok", true}, {"cancelled", client_interrupt_signal != 0}};
}

Json local_interrupt_status()
{
    std::scoped_lock lock(local_interrupt_scope_mutex);
    return {{"ok", true},
            {"active", local_interrupt_scope_active},
            {"cancelled", local_interrupt_scope_active && client_interrupt_signal != 0}};
}

Json stop_local_interrupt_scope()
{
    std::scoped_lock lock(local_interrupt_scope_mutex);
    const bool cancelled = local_interrupt_scope_active && client_interrupt_signal != 0;
    if (local_interrupt_scope_active) {
        release_client_interrupt_handler();
        local_interrupt_scope_active = false;
    }
    return {{"ok", true}, {"cancelled", cancelled}};
}

Json wait_local_server()
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", false}, {"error", "daemon broker is not running in this process"}};
    auto result = server->wait();
    {
        std::scoped_lock lock(server_mutex);
        if (local_server == server)
            local_server.reset();
    }
    return result;
}

Json abort_local_server()
{
    std::shared_ptr<BrokerServer> server;
    {
        std::scoped_lock lock(server_mutex);
        server = local_server;
    }
    if (!server)
        return {{"ok", true}, {"state", "stopped"}};
    server->force_stop();
    {
        std::scoped_lock lock(server_mutex);
        if (local_server == server)
            local_server.reset();
    }
    return {{"ok", true}, {"state", "stopped"}};
}

#if !defined(_WIN32)
class StartupLock {
public:
    explicit StartupLock(const std::filesystem::path& path)
    {
        descriptor_ = ::open(path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
        if (descriptor_ < 0)
            throw std::runtime_error("failed to open daemon startup lock");
        if (::fchmod(descriptor_, 0600) != 0) {
            ::close(descriptor_);
            descriptor_ = -1;
            throw std::runtime_error("failed to restrict daemon startup lock permissions");
        }
    }
    ~StartupLock()
    {
        if (descriptor_ >= 0)
            ::close(descriptor_);
    }
    bool try_acquire() { return ::flock(descriptor_, LOCK_EX | LOCK_NB) == 0; }

private:
    int descriptor_ = -1;
};

bool safe_remove_stale_socket(const Endpoint& endpoint)
{
    const int lifetime =
        ::open(endpoint.lifetime_lock_path.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (lifetime < 0)
        return false;
    const bool unowned = ::fchmod(lifetime, 0600) == 0 && ::flock(lifetime, LOCK_EX | LOCK_NB) == 0;
    if (!unowned) {
        ::close(lifetime);
        return false;
    }
    struct stat info {};
    bool safe = false;
    if (::lstat(endpoint.socket_path.c_str(), &info) != 0)
        safe = errno == ENOENT;
    else if (S_ISSOCK(info.st_mode) && info.st_uid == geteuid())
        safe = ::unlink(endpoint.socket_path.c_str()) == 0 || errno == ENOENT;
    ::flock(lifetime, LOCK_UN);
    ::close(lifetime);
    return safe;
}

std::optional<ChildProcess> spawn_project_owner_process(const BrokerContext& context,
                                                        std::uint64_t owner_worker_id)
{
    const auto executable_path = current_executable_path();
    if (!executable_path)
        return std::nullopt;
    const auto protocol = std::to_string(context.protocol);
    const auto daemon_idle = std::to_string(context.daemon_idle_ms);
    const auto project_idle = std::to_string(context.project_session_idle_ms);
    const auto worker_id = std::to_string(owner_worker_id);
    const auto runtime_root =
        context.runtime_root_override ? context.runtime_root_override->string() : std::string{};
    const auto child = ::fork();
    if (child < 0)
        return std::nullopt;
    if (child == 0) {
        const int devnull = ::open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            ::dup2(devnull, STDIN_FILENO);
            ::dup2(devnull, STDOUT_FILENO);
            ::dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO)
                ::close(devnull);
        }
        if (runtime_root.empty()) {
            ::execl(executable_path->c_str(), executable_path->c_str(), "__daemon-owner",
                    "--daemon-build", context.build.c_str(), "--daemon-protocol", protocol.c_str(),
                    "--daemon-idle-ms", daemon_idle.c_str(), "--project-session-idle-ms",
                    project_idle.c_str(), "--owner-worker-id", worker_id.c_str(),
                    static_cast<char*>(nullptr));
        } else {
            ::execl(executable_path->c_str(), executable_path->c_str(), "__daemon-owner",
                    "--daemon-build", context.build.c_str(), "--daemon-protocol", protocol.c_str(),
                    "--daemon-idle-ms", daemon_idle.c_str(), "--project-session-idle-ms",
                    project_idle.c_str(), "--daemon-runtime-root", runtime_root.c_str(),
                    "--owner-worker-id", worker_id.c_str(), static_cast<char*>(nullptr));
        }
        _exit(127);
    }
    return ChildProcess{.pid = child};
}

std::optional<ChildProcess> spawn_disposable_worker_process(const BrokerContext& context,
                                                            std::uint64_t worker_id_value)
{
    const auto executable_path = current_executable_path();
    if (!executable_path)
        return std::nullopt;
    const auto protocol = std::to_string(context.protocol);
    const auto daemon_idle = std::to_string(context.daemon_idle_ms);
    const auto project_idle = std::to_string(context.project_session_idle_ms);
    const auto worker_id = std::to_string(worker_id_value);
    const auto runtime_root =
        context.runtime_root_override ? context.runtime_root_override->string() : std::string{};
    const auto child = ::fork();
    if (child < 0)
        return std::nullopt;
    if (child == 0) {
        const int devnull = ::open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            ::dup2(devnull, STDIN_FILENO);
            ::dup2(devnull, STDOUT_FILENO);
            ::dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO)
                ::close(devnull);
        }
        if (runtime_root.empty()) {
            ::execl(executable_path->c_str(), executable_path->c_str(), "__daemon-disposable",
                    "--daemon-build", context.build.c_str(), "--daemon-protocol", protocol.c_str(),
                    "--daemon-idle-ms", daemon_idle.c_str(), "--project-session-idle-ms",
                    project_idle.c_str(), "--disposable-worker-id", worker_id.c_str(),
                    static_cast<char*>(nullptr));
        } else {
            ::execl(executable_path->c_str(), executable_path->c_str(), "__daemon-disposable",
                    "--daemon-build", context.build.c_str(), "--daemon-protocol", protocol.c_str(),
                    "--daemon-idle-ms", daemon_idle.c_str(), "--project-session-idle-ms",
                    project_idle.c_str(), "--daemon-runtime-root", runtime_root.c_str(),
                    "--disposable-worker-id", worker_id.c_str(), static_cast<char*>(nullptr));
        }
        _exit(127);
    }
    return ChildProcess{.pid = child};
}

bool child_process_alive(const ChildProcess& process)
{
    if (process.pid <= 0)
        return false;
    for (;;) {
        int status = 0;
        const auto result = ::waitpid(process.pid, &status, WNOHANG);
        if (result == 0)
            return true;
        if (result == process.pid)
            return false;
        if (errno == EINTR)
            continue;
        return errno == ECHILD ? (::kill(process.pid, 0) == 0 || errno == EPERM) : false;
    }
}

void terminate_child_process(ChildProcess& process)
{
    if (process.pid <= 0)
        return;
    if (child_process_alive(process))
        (void)::kill(process.pid, SIGTERM);
    for (int attempt = 0; attempt < 20; ++attempt) {
        int status = 0;
        const auto result = ::waitpid(process.pid, &status, WNOHANG);
        if (result == process.pid || (result < 0 && errno == ECHILD)) {
            process.pid = -1;
            return;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    (void)::kill(process.pid, SIGKILL);
    (void)::waitpid(process.pid, nullptr, 0);
    process.pid = -1;
}

void release_child_process(ChildProcess& process)
{
    if (process.pid <= 0)
        return;
    int status = 0;
    (void)::waitpid(process.pid, &status, WNOHANG);
    process.pid = -1;
}

bool spawn_daemon_process(const std::string& executable_path, const BrokerContext& context)
{
    const auto protocol = std::to_string(context.protocol);
    const auto daemon_idle = std::to_string(context.daemon_idle_ms);
    const auto project_idle = std::to_string(context.project_session_idle_ms);
    const auto runtime_root =
        context.runtime_root_override ? context.runtime_root_override->string() : std::string{};
    const auto child = ::fork();
    if (child < 0)
        return false;
    if (child == 0) {
        ::setsid();
        const int devnull = ::open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            ::dup2(devnull, STDIN_FILENO);
            ::dup2(devnull, STDOUT_FILENO);
            ::dup2(devnull, STDERR_FILENO);
            if (devnull > STDERR_FILENO)
                ::close(devnull);
        }
        if (runtime_root.empty()) {
            ::execl(executable_path.c_str(), executable_path.c_str(), "__daemon-broker",
                    "--daemon-build", context.build.c_str(), "--daemon-protocol", protocol.c_str(),
                    "--daemon-idle-ms", daemon_idle.c_str(), "--project-session-idle-ms",
                    project_idle.c_str(), static_cast<char*>(nullptr));
        } else {
            ::execl(executable_path.c_str(), executable_path.c_str(), "__daemon-broker",
                    "--daemon-build", context.build.c_str(), "--daemon-protocol", protocol.c_str(),
                    "--daemon-idle-ms", daemon_idle.c_str(), "--project-session-idle-ms",
                    project_idle.c_str(), "--daemon-runtime-root", runtime_root.c_str(),
                    static_cast<char*>(nullptr));
        }
        _exit(127);
    }
    return true;
}
#else
class StartupLock {
public:
    explicit StartupLock(const Endpoint& endpoint)
    {
        auto security_owner = current_user_security_descriptor();
        SECURITY_ATTRIBUTES attributes{};
        attributes.nLength = sizeof(attributes);
        attributes.lpSecurityDescriptor = security_owner.descriptor;
        attributes.bInheritHandle = FALSE;
        handle_ = CreateMutexW(&attributes, FALSE, endpoint.startup_mutex_name.c_str());
        if (handle_ == nullptr)
            throw std::runtime_error("failed to create daemon startup mutex");
        already_exists_ = GetLastError() == ERROR_ALREADY_EXISTS;
    }
    ~StartupLock()
    {
        if (owned_)
            ReleaseMutex(handle_);
        if (handle_ != nullptr)
            CloseHandle(handle_);
    }
    bool try_acquire()
    {
        if (already_exists_) {
            const auto result = WaitForSingleObject(handle_, 0);
            if (result != WAIT_OBJECT_0 && result != WAIT_ABANDONED)
                return false;
        } else {
            const auto result = WaitForSingleObject(handle_, 0);
            if (result != WAIT_OBJECT_0)
                return false;
        }
        owned_ = true;
        return true;
    }

private:
    HANDLE handle_ = nullptr;
    bool already_exists_ = false;
    bool owned_ = false;
};

std::wstring quote_windows_argument(std::wstring_view value)
{
    std::wstring result = L"\"";
    std::size_t slashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++slashes;
            continue;
        }
        if (character == L'\"') {
            result.append(slashes * 2 + 1, L'\\');
            result.push_back(L'\"');
            slashes = 0;
            continue;
        }
        result.append(slashes, L'\\');
        slashes = 0;
        result.push_back(character);
    }
    result.append(slashes * 2, L'\\');
    result.push_back(L'\"');
    return result;
}

std::optional<ChildProcess> spawn_project_owner_process(const BrokerContext& context,
                                                        std::uint64_t owner_worker_id)
{
    const auto executable_path = current_executable_path();
    if (!executable_path)
        return std::nullopt;
    std::vector<std::wstring> args = {utf8_to_wide(*executable_path),
                                      L"__daemon-owner",
                                      L"--daemon-build",
                                      utf8_to_wide(context.build),
                                      L"--daemon-protocol",
                                      std::to_wstring(context.protocol),
                                      L"--daemon-idle-ms",
                                      std::to_wstring(context.daemon_idle_ms),
                                      L"--project-session-idle-ms",
                                      std::to_wstring(context.project_session_idle_ms)};
    if (context.runtime_root_override) {
        args.push_back(L"--daemon-runtime-root");
        args.push_back(context.runtime_root_override->wstring());
    }
    args.push_back(L"--owner-worker-id");
    args.push_back(std::to_wstring(owner_worker_id));
    std::wstring command_line;
    for (const auto& argument : args) {
        if (!command_line.empty())
            command_line.push_back(L' ');
        command_line += quote_windows_argument(argument);
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
    mutable_command.push_back(L'\0');
    if (!CreateProcessW(nullptr, mutable_command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr, nullptr, &startup, &process))
        return std::nullopt;
    CloseHandle(process.hThread);
    return ChildProcess{.handle = process.hProcess, .pid = process.dwProcessId};
}

std::optional<ChildProcess> spawn_disposable_worker_process(const BrokerContext& context,
                                                            std::uint64_t worker_id)
{
    const auto executable_path = current_executable_path();
    if (!executable_path)
        return std::nullopt;
    std::vector<std::wstring> args = {utf8_to_wide(*executable_path),
                                      L"__daemon-disposable",
                                      L"--daemon-build",
                                      utf8_to_wide(context.build),
                                      L"--daemon-protocol",
                                      std::to_wstring(context.protocol),
                                      L"--daemon-idle-ms",
                                      std::to_wstring(context.daemon_idle_ms),
                                      L"--project-session-idle-ms",
                                      std::to_wstring(context.project_session_idle_ms)};
    if (context.runtime_root_override) {
        args.push_back(L"--daemon-runtime-root");
        args.push_back(context.runtime_root_override->wstring());
    }
    args.push_back(L"--disposable-worker-id");
    args.push_back(std::to_wstring(worker_id));
    std::wstring command_line;
    for (const auto& argument : args) {
        if (!command_line.empty())
            command_line.push_back(L' ');
        command_line += quote_windows_argument(argument);
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
    mutable_command.push_back(L'\0');
    if (!CreateProcessW(nullptr, mutable_command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr, nullptr, &startup, &process))
        return std::nullopt;
    CloseHandle(process.hThread);
    return ChildProcess{.handle = process.hProcess, .pid = process.dwProcessId};
}

bool child_process_alive(const ChildProcess& process)
{
    if (process.handle == nullptr)
        return false;
    DWORD exit_code = 0;
    return GetExitCodeProcess(process.handle, &exit_code) && exit_code == STILL_ACTIVE;
}

void terminate_child_process(ChildProcess& process)
{
    if (process.handle == nullptr)
        return;
    if (child_process_alive(process)) {
        (void)TerminateProcess(process.handle, 1);
        (void)WaitForSingleObject(process.handle, 1000);
    }
    CloseHandle(process.handle);
    process.handle = nullptr;
    process.pid = 0;
}

void release_child_process(ChildProcess& process)
{
    if (process.handle != nullptr)
        CloseHandle(process.handle);
    process.handle = nullptr;
    process.pid = 0;
}

bool spawn_daemon_process(const std::string& executable_path, const BrokerContext& context)
{
    std::vector<std::wstring> args = {utf8_to_wide(executable_path),
                                      L"__daemon-broker",
                                      L"--daemon-build",
                                      utf8_to_wide(context.build),
                                      L"--daemon-protocol",
                                      std::to_wstring(context.protocol),
                                      L"--daemon-idle-ms",
                                      std::to_wstring(context.daemon_idle_ms),
                                      L"--project-session-idle-ms",
                                      std::to_wstring(context.project_session_idle_ms)};
    if (context.runtime_root_override) {
        args.push_back(L"--daemon-runtime-root");
        args.push_back(context.runtime_root_override->wstring());
    }
    std::wstring command_line;
    for (const auto& argument : args) {
        if (!command_line.empty())
            command_line.push_back(L' ');
        command_line += quote_windows_argument(argument);
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    std::vector<wchar_t> mutable_command(command_line.begin(), command_line.end());
    mutable_command.push_back(L'\0');
    if (!CreateProcessW(nullptr, mutable_command.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW | DETACHED_PROCESS, nullptr, nullptr, &startup, &process))
        return false;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return true;
}
#endif

Json ensure_daemon(const Json& request, const BrokerContext& context)
{
    std::optional<std::string> executable_path;
    if (request.contains("executablePath")) {
        if (!request["executablePath"].is_string() ||
            request["executablePath"].get_ref<const std::string&>().empty())
            return {{"ok", false}, {"error", "daemon executablePath must be a non-empty path"}};
        executable_path = request["executablePath"].get<std::string>();
    } else {
        executable_path = current_executable_path();
        if (!executable_path)
            return {{"ok", false}, {"error", "failed to resolve current daemon executable path"}};
    }
    const auto timeout_ms = request.value("startupTimeoutMs", static_cast<std::uint64_t>(2000));
    if (timeout_ms == 0 || timeout_ms > 30000)
        return {{"ok", false}, {"error", "daemon startupTimeoutMs is out of range"}};

    const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
    auto current =
        client_request(context, "status", "ensure-status", Json::object(), std::nullopt, deadline);
    if (current.value("running", false)) {
        current["started"] = false;
        return current;
    }

    Endpoint endpoint;
    try {
        endpoint = make_endpoint(context);
    } catch (const std::exception& error) {
        return {{"ok", false}, {"error", error.what()}};
    }

    std::unique_ptr<StartupLock> startup_lock;
    try {
#if defined(_WIN32)
        startup_lock = std::make_unique<StartupLock>(endpoint);
#else
        startup_lock = std::make_unique<StartupLock>(endpoint.startup_lock_path);
#endif
    } catch (const std::exception& error) {
        return {{"ok", false}, {"error", error.what()}};
    }

    const bool owner = startup_lock->try_acquire();
    bool spawned = false;
    if (owner) {
        current = client_request(context, "status", "ensure-status-owner", Json::object(),
                                 std::nullopt, deadline);
        if (!current.value("running", false)) {
#if !defined(_WIN32)
            if (!safe_remove_stale_socket(endpoint))
                return {{"ok", false}, {"error", "refusing unsafe daemon endpoint takeover"}};
#endif
            if (!spawn_daemon_process(*executable_path, context))
                return {{"ok", false}, {"error", "failed to spawn daemon process"}};
            spawned = true;
        }
    }

    while (Clock::now() < deadline) {
        auto status = client_request(context, "status", "ensure-status-wait", Json::object(),
                                     std::nullopt, deadline);
        if (status.value("running", false)) {
            status["started"] = spawned;
            return status;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return {{"ok", false},
            {"error", "daemon broker did not become reachable before startup timeout"}};
}

class OwnerControlChannel {
public:
    ~OwnerControlChannel() { reset(); }

    Json request(const BrokerContext& context, std::string_view method, std::string request_id,
                 const Json& payload)
    {
        std::scoped_lock lock(mutex_);
        Endpoint endpoint;
        try {
            endpoint = make_endpoint(context);
        } catch (const std::exception& error) {
            return {{"ok", false}, {"error", error.what()}};
        }
        const auto endpoint_key = key(endpoint);
        if (connection_ == invalid_connection || endpoint_key_ != endpoint_key) {
            reset_locked();
            connection_ = connect_endpoint(endpoint);
            if (connection_ == invalid_connection)
                return {{"ok", false}, {"error", "daemon broker is not reachable"}};
            endpoint_key_ = endpoint_key;
        }

        const Json request = {{"type", "request"},
                              {"requestId", request_id},
                              {"method", std::string(method)},
                              {"payload", payload}};
        if (!send_payload(connection_, request.dump())) {
            reset_locked();
            return {{"ok", false}, {"error", "failed to send daemon owner request"}};
        }
        const auto response = receive_payload(connection_);
        if (!response) {
            reset_locked();
            return {{"ok", false}, {"error", "daemon broker closed owner control channel"}};
        }
        auto event = Json::parse(*response, nullptr, false);
        if (event.is_discarded() || event.value("requestId", std::string{}) != request_id ||
            event.value("type", std::string{}) != "result") {
            reset_locked();
            return {{"ok", false}, {"error", "daemon broker returned an invalid owner result"}};
        }
        return event;
    }

private:
    static std::string key(const Endpoint& endpoint)
    {
#if defined(_WIN32)
        return endpoint.identity + "\n" + wide_to_utf8(endpoint.pipe_name);
#else
        return endpoint.socket_path.string();
#endif
    }

    void reset()
    {
        std::scoped_lock lock(mutex_);
        reset_locked();
    }

    void reset_locked()
    {
        close_outbound_connection(connection_);
        connection_ = invalid_connection;
        endpoint_key_.clear();
    }

    std::mutex mutex_;
    ConnectionHandle connection_ = invalid_connection;
    std::string endpoint_key_;
};

Json owner_client_request(const BrokerContext& context, std::string_view method,
                          const Json& payload)
{
    static std::atomic<std::uint64_t> sequence{1};
    static OwnerControlChannel channel;
    const auto request_id =
        "owner-control-" + std::to_string(sequence.fetch_add(1, std::memory_order_relaxed));
    auto response = channel.request(context, method, request_id, payload);
    if (response.value("type", std::string{}) != "result")
        return response;
    if (!response.value("ok", false))
        return {{"ok", false},
                {"error", response.value("error", std::string("daemon owner request failed"))}};
    if (response.contains("result") && response["result"].is_object())
        return response["result"];
    return {{"ok", false}, {"error", "daemon owner request returned no result"}};
}

std::uint64_t write_response(const Json& result, std::uint8_t* response,
                             std::uint64_t response_capacity)
{
    const auto text = result.dump();
    const auto required = static_cast<std::uint64_t>(text.size());
    if (response != nullptr && response_capacity >= required && required != 0)
        std::memcpy(response, text.data(), text.size());
    return required;
}

} // namespace

struct ProjectSnapshotStore::Impl {
    struct StoredSnapshot {
        std::string canonical_root;
        ProjectGenerationIdentity identity;
        std::vector<std::string> opaque_chunks;
        std::string opaque_owner_metadata;
        ProjectAuthorityCheckpoint authority_checkpoint;
        std::size_t byte_size = 0;
        std::size_t pin_count = 0;
        std::uint64_t last_used_millis = 0;
    };

    struct RootState {
        std::optional<ProjectGenerationIdentity> current;
        std::optional<ProjectGenerationIdentity> rehydration_candidate;
        std::vector<StoredSnapshot> snapshots;
    };

    mutable std::mutex mutex;
    std::unordered_map<std::string, RootState> roots;

    static std::size_t authority_checkpoint_bytes(const ProjectAuthorityCheckpoint& checkpoint)
    {
        std::size_t total = sizeof(ProjectAuthorityCheckpoint);
        total +=
            checkpoint.canonical_root.native().size() * sizeof(std::filesystem::path::value_type);
        total += checkpoint.authoritative_paths.size() * sizeof(std::string);
        for (const auto& path : checkpoint.authoritative_paths)
            total += path.size();
        total += checkpoint.discovery_scopes.size() * sizeof(ProjectSourceDiscoveryScope);
        for (const auto& scope : checkpoint.discovery_scopes) {
            total += scope.root.size();
            total += scope.extensions.size() * sizeof(std::string);
            for (const auto& extension : scope.extensions)
                total += extension.size();
            total += scope.excluded_prefixes.size() * sizeof(std::string);
            for (const auto& prefix : scope.excluded_prefixes)
                total += prefix.size();
        }
        total += sizeof(ProjectSourceManifest) + checkpoint.manifest.canonical_root.size();
        total += checkpoint.manifest.entries.size() * sizeof(ProjectSourceManifestEntry);
        for (const auto& entry : checkpoint.manifest.entries) {
            total += entry.path.size() + entry.source_identity.size();
            if (entry.content_hash)
                total += entry.content_hash->size();
        }
        return total;
    }

    static std::size_t bytes(const std::vector<std::string>& chunks, std::string_view metadata,
                             const ProjectAuthorityCheckpoint& authority_checkpoint)
    {
        std::size_t total = metadata.size() + authority_checkpoint_bytes(authority_checkpoint);
        for (const auto& chunk : chunks)
            total += chunk.size();
        return total;
    }

    static auto find(RootState& root, ProjectGenerationIdentity identity)
    {
        return std::find_if(root.snapshots.begin(), root.snapshots.end(),
                            [&](const auto& snapshot) { return snapshot.identity == identity; });
    }

    static auto find(const RootState& root, ProjectGenerationIdentity identity)
    {
        return std::find_if(root.snapshots.begin(), root.snapshots.end(),
                            [&](const auto& snapshot) { return snapshot.identity == identity; });
    }

    static RetainedProjectSnapshot describe(const StoredSnapshot& snapshot)
    {
        return RetainedProjectSnapshot{
            .canonical_root = snapshot.canonical_root,
            .identity = snapshot.identity,
            .opaque_owner_metadata = snapshot.opaque_owner_metadata,
            .chunk_count = snapshot.opaque_chunks.size(),
            .byte_size = snapshot.byte_size,
            .pin_count = snapshot.pin_count,
            .last_used_millis = snapshot.last_used_millis,
        };
    }

    static void prune_obsolete(RootState& root)
    {
        std::erase_if(root.snapshots, [&](const auto& snapshot) {
            return snapshot.pin_count == 0 && (!root.rehydration_candidate.has_value() ||
                                               snapshot.identity != *root.rehydration_candidate);
        });
    }
};

ProjectSnapshotStore::ProjectSnapshotStore() : impl_(std::make_shared<Impl>()) {}

bool ProjectSnapshotStore::declare_current(std::string canonical_root,
                                           ProjectGenerationIdentity identity,
                                           std::uint64_t now_millis)
{
    if (canonical_root.empty() || identity.session_epoch == 0 || identity.generation == 0)
        return false;
    std::scoped_lock lock(impl_->mutex);
    auto& root = impl_->roots[canonical_root];
    root.current = identity;
    const auto current = Impl::find(root, identity);
    if (current != root.snapshots.end())
        current->last_used_millis = now_millis;
    Impl::prune_obsolete(root);
    return true;
}

bool ProjectSnapshotStore::publish(std::string canonical_root, ProjectGenerationIdentity identity,
                                   std::vector<std::string> opaque_chunks,
                                   std::string opaque_owner_metadata,
                                   ProjectAuthorityCheckpoint authority_checkpoint,
                                   std::uint64_t now_millis)
{
    if (canonical_root.empty() || identity.session_epoch == 0 || identity.generation == 0 ||
        opaque_chunks.empty())
        return false;
    std::scoped_lock lock(impl_->mutex);
    auto& root = impl_->roots[canonical_root];
    if (!root.current || *root.current != identity)
        return false;

    auto existing = Impl::find(root, identity);
    if (existing != root.snapshots.end()) {
        if (existing->pin_count != 0 && (existing->opaque_chunks != opaque_chunks ||
                                         existing->opaque_owner_metadata != opaque_owner_metadata))
            return false;
        existing->opaque_chunks = std::move(opaque_chunks);
        existing->opaque_owner_metadata = std::move(opaque_owner_metadata);
        existing->authority_checkpoint = std::move(authority_checkpoint);
        existing->byte_size = Impl::bytes(existing->opaque_chunks, existing->opaque_owner_metadata,
                                          existing->authority_checkpoint);
        existing->last_used_millis = now_millis;
    } else {
        root.snapshots.push_back(Impl::StoredSnapshot{
            .canonical_root = canonical_root,
            .identity = identity,
            .opaque_chunks = std::move(opaque_chunks),
            .opaque_owner_metadata = std::move(opaque_owner_metadata),
            .authority_checkpoint = std::move(authority_checkpoint),
            .byte_size = 0,
            .pin_count = 0,
            .last_used_millis = now_millis,
        });
        auto& inserted = root.snapshots.back();
        inserted.byte_size = Impl::bytes(inserted.opaque_chunks, inserted.opaque_owner_metadata,
                                         inserted.authority_checkpoint);
    }
    root.rehydration_candidate = identity;
    Impl::prune_obsolete(root);
    return true;
}

std::optional<RetainedProjectSnapshot> ProjectSnapshotStore::latest(std::string_view canonical_root,
                                                                    std::uint64_t now_millis)
{
    if (!impl_)
        return std::nullopt;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end() || !root->second.rehydration_candidate)
        return std::nullopt;
    auto snapshot = Impl::find(root->second, *root->second.rehydration_candidate);
    if (snapshot == root->second.snapshots.end())
        return std::nullopt;
    snapshot->last_used_millis = now_millis;
    return Impl::describe(*snapshot);
}

std::optional<RetainedProjectSnapshot>
ProjectSnapshotStore::find(std::string_view canonical_root, ProjectGenerationIdentity identity,
                           std::uint64_t now_millis)
{
    if (!impl_)
        return std::nullopt;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end())
        return std::nullopt;
    auto snapshot = Impl::find(root->second, identity);
    if (snapshot == root->second.snapshots.end())
        return std::nullopt;
    snapshot->last_used_millis = now_millis;
    return Impl::describe(*snapshot);
}

std::optional<std::string> ProjectSnapshotStore::chunk(std::string_view canonical_root,
                                                       ProjectGenerationIdentity identity,
                                                       std::size_t index, std::uint64_t now_millis)
{
    if (!impl_)
        return std::nullopt;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end())
        return std::nullopt;
    auto snapshot = Impl::find(root->second, identity);
    if (snapshot == root->second.snapshots.end() || index >= snapshot->opaque_chunks.size())
        return std::nullopt;
    snapshot->last_used_millis = now_millis;
    return snapshot->opaque_chunks[index];
}

std::optional<ProjectAuthorityCheckpoint> ProjectSnapshotStore::authority_checkpoint(
    std::string_view canonical_root, ProjectGenerationIdentity identity, std::uint64_t now_millis)
{
    if (!impl_)
        return std::nullopt;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end())
        return std::nullopt;
    auto snapshot = Impl::find(root->second, identity);
    if (snapshot == root->second.snapshots.end())
        return std::nullopt;
    snapshot->last_used_millis = now_millis;
    return snapshot->authority_checkpoint;
}

bool ProjectSnapshotStore::pin_current(std::string_view canonical_root,
                                       ProjectGenerationIdentity identity, std::uint64_t now_millis)
{
    if (!impl_)
        return false;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end() || !root->second.current || *root->second.current != identity)
        return false;
    auto snapshot = Impl::find(root->second, identity);
    if (snapshot == root->second.snapshots.end())
        return false;
    ++snapshot->pin_count;
    snapshot->last_used_millis = now_millis;
    return true;
}

bool ProjectSnapshotStore::unpin(std::string_view canonical_root,
                                 ProjectGenerationIdentity identity, std::uint64_t now_millis)
{
    if (!impl_)
        return false;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end())
        return false;
    auto snapshot = Impl::find(root->second, identity);
    if (snapshot == root->second.snapshots.end() || snapshot->pin_count == 0)
        return false;
    --snapshot->pin_count;
    snapshot->last_used_millis = now_millis;
    Impl::prune_obsolete(root->second);
    if (root->second.snapshots.empty())
        impl_->roots.erase(root);
    return true;
}

void ProjectSnapshotStore::invalidate_current(std::string_view canonical_root)
{
    if (!impl_)
        return;
    std::scoped_lock lock(impl_->mutex);
    const auto root = impl_->roots.find(std::string(canonical_root));
    if (root == impl_->roots.end())
        return;
    root->second.current.reset();
    root->second.rehydration_candidate.reset();
    Impl::prune_obsolete(root->second);
    if (root->second.snapshots.empty())
        impl_->roots.erase(root);
}

void ProjectSnapshotStore::trim_dormant_to_budget(const std::vector<std::string>& active_roots,
                                                  std::size_t byte_budget)
{
    if (!impl_)
        return;
    std::scoped_lock lock(impl_->mutex);
    const std::unordered_set<std::string> active(active_roots.begin(), active_roots.end());
    std::size_t total = 0;
    for (const auto& [root_name, root] : impl_->roots) {
        (void)root_name;
        for (const auto& snapshot : root.snapshots)
            total += snapshot.byte_size;
    }
    while (total > byte_budget) {
        std::string candidate_root;
        ProjectGenerationIdentity candidate_identity{};
        std::uint64_t candidate_used = UINT64_MAX;
        bool found = false;
        for (const auto& [root_name, root] : impl_->roots) {
            if (active.contains(root_name))
                continue;
            for (const auto& snapshot : root.snapshots) {
                if (snapshot.pin_count != 0)
                    continue;
                if (!found || snapshot.last_used_millis < candidate_used) {
                    candidate_root = root_name;
                    candidate_identity = snapshot.identity;
                    candidate_used = snapshot.last_used_millis;
                    found = true;
                }
            }
        }
        if (!found)
            break;
        auto root = impl_->roots.find(candidate_root);
        auto snapshot = Impl::find(root->second, candidate_identity);
        total -= snapshot->byte_size;
        if (root->second.rehydration_candidate &&
            *root->second.rehydration_candidate == candidate_identity)
            root->second.rehydration_candidate.reset();
        root->second.snapshots.erase(snapshot);
        if (root->second.snapshots.empty())
            impl_->roots.erase(root);
    }
}

std::size_t ProjectSnapshotStore::retained_bytes() const
{
    if (!impl_)
        return 0;
    std::scoped_lock lock(impl_->mutex);
    std::size_t total = 0;
    for (const auto& [root_name, root] : impl_->roots) {
        (void)root_name;
        for (const auto& snapshot : root.snapshots)
            total += snapshot.byte_size;
    }
    return total;
}

std::size_t ProjectSnapshotStore::snapshot_count() const
{
    if (!impl_)
        return 0;
    std::scoped_lock lock(impl_->mutex);
    std::size_t count = 0;
    for (const auto& [root_name, root] : impl_->roots) {
        (void)root_name;
        count += root.snapshots.size();
    }
    return count;
}

std::string canonical_project_owner_root(std::string_view project_root, bool search_upwards)
{
#if defined(_WIN32)
    std::filesystem::path logical = utf8_to_wide(project_root);
#else
    std::filesystem::path logical = std::string(project_root);
#endif
    std::error_code error;
    logical = std::filesystem::absolute(logical, error);
    if (error || logical.empty())
        throw std::runtime_error("Cannot resolve Project owner nomination");

    if (search_upwards) {
        auto candidate = logical.lexically_normal();
        bool found_project = false;
        for (;;) {
            error.clear();
            if (std::filesystem::exists(candidate / "project.json", error) && !error) {
                logical = candidate;
                found_project = true;
                break;
            }
            const auto parent = candidate.parent_path();
            if (parent.empty() || parent == candidate)
                break;
            candidate = parent;
        }
        if (!found_project)
            return {};
    } else {
        error.clear();
        if (!std::filesystem::exists(logical / "project.json", error) || error)
            return {};
    }

    error.clear();
    const auto canonical = std::filesystem::canonical(logical, error);
    if (error || canonical.empty())
        throw std::runtime_error("Cannot resolve canonical Project owner root");
    error.clear();
    if (!std::filesystem::is_directory(canonical, error) || error)
        throw std::runtime_error("Cannot resolve canonical Project owner root");
#if defined(_WIN32)
    return wide_to_utf8(canonical.lexically_normal().wstring());
#else
    return canonical.lexically_normal().string();
#endif
}

bool FrameDecoder::feed(std::span<const std::uint8_t> bytes)
{
    if (!error_.empty())
        return false;
    buffer_.insert(buffer_.end(), bytes.begin(), bytes.end());
    while (buffer_.size() >= 4) {
        const std::uint32_t length = (static_cast<std::uint32_t>(buffer_[0]) << 24U) |
                                     (static_cast<std::uint32_t>(buffer_[1]) << 16U) |
                                     (static_cast<std::uint32_t>(buffer_[2]) << 8U) |
                                     static_cast<std::uint32_t>(buffer_[3]);
        if (length == 0 || length > max_frame_bytes) {
            error_ = length == 0 ? "daemon frame is empty" : "daemon frame exceeds maximum size";
            return false;
        }
        if (buffer_.size() < static_cast<std::size_t>(length) + 4)
            return true;
        frames_.emplace_back(reinterpret_cast<const char*>(buffer_.data() + 4), length);
        buffer_.erase(buffer_.begin(), buffer_.begin() + static_cast<std::ptrdiff_t>(length + 4));
    }
    return true;
}

const std::vector<std::string>& FrameDecoder::frames() const noexcept { return frames_; }
std::string_view FrameDecoder::error() const noexcept { return error_; }
void FrameDecoder::clear_frames() { frames_.clear(); }

std::vector<std::uint8_t> encode_frame(std::string_view payload)
{
    if (payload.empty() || payload.size() > max_frame_bytes)
        return {};
    const auto size = static_cast<std::uint32_t>(payload.size());
    std::vector<std::uint8_t> frame(payload.size() + 4);
    frame[0] = static_cast<std::uint8_t>((size >> 24U) & 0xffU);
    frame[1] = static_cast<std::uint8_t>((size >> 16U) & 0xffU);
    frame[2] = static_cast<std::uint8_t>((size >> 8U) & 0xffU);
    frame[3] = static_cast<std::uint8_t>(size & 0xffU);
    std::memcpy(frame.data() + 4, payload.data(), payload.size());
    return frame;
}

std::string endpoint_identity(std::string_view build_identity,
                              std::uint32_t daemon_protocol_version)
{
    const auto material =
        std::string(build_identity) + "\n" + std::to_string(daemon_protocol_version);
    return sha256_text(material).substr(0, 32);
}

std::string result_event_json(std::string_view request_id, bool ok, std::string_view result_json,
                              std::string_view error)
{
    Json result = Json::parse(result_json, nullptr, false);
    if (result.is_discarded())
        result = nullptr;
    Json event = {{"type", "result"},
                  {"requestId", request_id},
                  {"ok", ok},
                  {"final", true},
                  {"result", std::move(result)}};
    if (!error.empty())
        event["error"] = error;
    return event.dump();
}

std::string text_event_json(std::string_view type, std::string_view request_id,
                            std::string_view text)
{
    if (type != "stdout" && type != "stderr")
        throw std::invalid_argument("daemon text event type must be stdout or stderr");
    return Json{{"type", type}, {"requestId", request_id}, {"text", text}}.dump();
}

std::string progress_event_json(std::string_view request_id, std::string_view message,
                                std::uint64_t completed, std::uint64_t total)
{
    return Json{{"type", "progress"},
                {"requestId", request_id},
                {"message", message},
                {"completed", completed},
                {"total", total}}
        .dump();
}

std::string cancellation_event_json(std::string_view request_id)
{
    return Json{{"type", "cancel"}, {"requestId", request_id}}.dump();
}

} // namespace noveltea::tooling::daemon

extern "C" std::uint64_t noveltea_tooling_daemon_json(const std::uint8_t* request,
                                                      std::uint64_t request_size,
                                                      std::uint8_t* response,
                                                      std::uint64_t response_capacity)
{
    using namespace noveltea::tooling::daemon;
    using Json = nlohmann::json;
    if (request == nullptr)
        return write_response({{"ok", false}, {"error", "daemon request is missing"}}, response,
                              response_capacity);
    const auto parsed = Json::parse(std::string_view(reinterpret_cast<const char*>(request),
                                                     static_cast<std::size_t>(request_size)),
                                    nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object())
        return write_response({{"ok", false}, {"error", "malformed daemon request JSON"}}, response,
                              response_capacity);
    std::string context_error;
    const auto context = parse_context(parsed, context_error);
    if (!context)
        return write_response({{"ok", false}, {"error", std::move(context_error)}}, response,
                              response_capacity);

    const auto action = parsed.value("action", std::string{});
    Json result;
    if (action == "serve-start")
        result = start_local_server(*context);
    else if (action == "serve-ready")
        result = mark_local_ready();
    else if (action == "serve-next")
        result = take_local_request();
    else if (action == "serve-complete")
        result = complete_local_request(parsed);
    else if (action == "serve-event")
        result = emit_local_request_event(parsed);
    else if (action == "serve-cancelled")
        result = local_cancellation_status(parsed);
    else if (action == "serve-enter-critical")
        result = enter_local_critical_section();
    else if (action == "serve-leave-critical")
        result = leave_local_critical_section();
    else if (action == "serve-project-sessions")
        result = set_local_project_session_count(parsed);
    else if (action == "serve-project-observe")
        result = observe_local_project(parsed);
    else if (action == "serve-project-release")
        result = release_local_project(parsed);
    else if (action == "owner-next")
        result = owner_client_request(*context, "owner-next", parsed);
    else if (action == "owner-complete")
        result = owner_client_request(*context, "owner-complete", parsed);
    else if (action == "owner-validation-result")
        result = owner_client_request(*context, "owner-validation-result", parsed);
    else if (action == "owner-event")
        result = owner_client_request(*context, "owner-event", parsed);
    else if (action == "owner-cancelled")
        result = owner_client_request(*context, "owner-cancelled", parsed);
    else if (action == "owner-needs-reconcile")
        result = owner_client_request(*context, "owner-needs-reconcile", parsed);
    else if (action == "owner-reconcile-complete")
        result = owner_client_request(*context, "owner-reconcile-complete", parsed);
    else if (action == "owner-enter-critical")
        result = owner_client_request(*context, "owner-enter-critical", parsed);
    else if (action == "owner-leave-critical")
        result = owner_client_request(*context, "owner-leave-critical", parsed);
    else if (action == "owner-project-sessions")
        result = owner_client_request(*context, "owner-project-sessions", parsed);
    else if (action == "owner-project-observe")
        result = owner_client_request(*context, "owner-project-observe", parsed);
    else if (action == "owner-project-release")
        result = owner_client_request(*context, "owner-project-release", parsed);
    else if (action == "owner-project-generation")
        result = owner_client_request(*context, "owner-project-generation", parsed);
    else if (action == "owner-snapshot-begin")
        result = owner_client_request(*context, "owner-snapshot-begin", parsed);
    else if (action == "owner-snapshot-chunk")
        result = owner_client_request(*context, "owner-snapshot-chunk", parsed);
    else if (action == "owner-snapshot-commit")
        result = owner_client_request(*context, "owner-snapshot-commit", parsed);
    else if (action == "owner-snapshot-describe")
        result = owner_client_request(*context, "owner-snapshot-describe", parsed);
    else if (action == "owner-snapshot-read")
        result = owner_client_request(*context, "owner-snapshot-read", parsed);
    else if (action == "disposable-ready")
        result = owner_client_request(*context, "disposable-ready", parsed);
    else if (action == "disposable-next")
        result = owner_client_request(*context, "disposable-next", parsed);
    else if (action == "disposable-cancelled")
        result = owner_client_request(*context, "disposable-cancelled", parsed);
    else if (action == "disposable-event")
        result = owner_client_request(*context, "disposable-event", parsed);
    else if (action == "disposable-snapshot-read")
        result = owner_client_request(*context, "disposable-snapshot-read", parsed);
    else if (action == "disposable-complete")
        result = owner_client_request(*context, "disposable-complete", parsed);
    else if (action == "local-cancel-start")
        result = start_local_interrupt_scope();
    else if (action == "local-cancelled")
        result = local_interrupt_status();
    else if (action == "local-cancel-stop")
        result = stop_local_interrupt_scope();
    else if (action == "serve-wait")
        result = wait_local_server();
    else if (action == "serve-abort")
        result = abort_local_server();
    else if (action == "status")
        result = client_request(*context, "status", "status");
    else if (action == "stop") {
        result = client_request(*context, "stop", "stop");
        const bool was_running = result.value("running", false);
        if (was_running) {
            const auto deadline = Clock::now() + std::chrono::seconds(2);
            while (Clock::now() < deadline) {
                const auto status = client_request(*context, "status", "stop-status");
                if (!status.value("running", false)) {
                    result = status;
                    break;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
        }
        result["stopped"] = was_running;
    } else if (action == "request") {
        const auto request_id = parsed.value("requestId", std::string{});
        const auto method = parsed.value("method", std::string{});
        if (request_id.empty() || method.empty())
            result = {{"ok", false}, {"error", "daemon request requires requestId and method"}};
        else {
            std::optional<std::uint64_t> cancel_after;
            if (parsed.contains("cancelAfterMs") && parsed["cancelAfterMs"].is_number_unsigned())
                cancel_after = parsed["cancelAfterMs"].get<std::uint64_t>();
            result = client_request(*context, method, request_id,
                                    parsed.value("payload", Json::object()), cancel_after);
        }
    } else if (action == "ensure")
        result = ensure_daemon(parsed, *context);
    else
        result = {{"ok", false}, {"error", "unknown daemon broker action"}};
    return write_response(result, response, response_capacity);
}
