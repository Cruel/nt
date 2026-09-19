#include "tooling_daemon_broker.hpp"
#include "tooling_native_c.h"

#include <noveltea/core/player_bootstrap.hpp>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
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
#include <sddl.h>
#include <windows.h>
#else
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#if defined(__APPLE__)
#include <mach-o/dyld.h>
#endif
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace noveltea::tooling::daemon {
namespace {

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;

struct BrokerContext {
    std::string build;
    std::uint32_t protocol = protocol_version;
    std::uint64_t daemon_idle_ms = default_daemon_idle_ms;
    std::uint64_t project_session_idle_ms = default_project_session_idle_ms;
    std::optional<std::filesystem::path> runtime_root_override;
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
    if (request.contains("runtimeRoot")) {
        if (!request["runtimeRoot"].is_string() ||
            request["runtimeRoot"].get_ref<const std::string&>().empty()) {
            error = "runtimeRoot must be a non-empty path";
            return std::nullopt;
        }
        context.runtime_root_override =
            std::filesystem::path(request["runtimeRoot"].get<std::string>());
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
    const std::string sid_ascii(sid.begin(), sid.end());
    const auto user_identity = sha256_text(sid_ascii).substr(0, 16);
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
constexpr ConnectionHandle invalid_connection = INVALID_HANDLE_VALUE;
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

bool read_exact(ConnectionHandle connection, std::uint8_t* target, std::size_t size)
{
    std::size_t offset = 0;
    while (offset < size) {
#if defined(_WIN32)
        DWORD read = 0;
        const auto chunk = static_cast<DWORD>(std::min<std::size_t>(size - offset, 64 * 1024));
        if (!ReadFile(connection, target + offset, chunk, &read, nullptr) || read == 0)
            return false;
        offset += read;
#else
        const auto read = ::recv(connection, target + offset, size - offset, 0);
        if (read <= 0) {
            if (read < 0 && errno == EINTR)
                continue;
            return false;
        }
        offset += static_cast<std::size_t>(read);
#endif
    }
    return true;
}

bool write_all(ConnectionHandle connection, std::span<const std::uint8_t> bytes)
{
    std::size_t offset = 0;
    while (offset < bytes.size()) {
#if defined(_WIN32)
        DWORD written = 0;
        const auto chunk =
            static_cast<DWORD>(std::min<std::size_t>(bytes.size() - offset, 64 * 1024));
        if (!WriteFile(connection, bytes.data() + offset, chunk, &written, nullptr) || written == 0)
            return false;
        offset += written;
#else
        const auto written =
            ::send(connection, bytes.data() + offset, bytes.size() - offset, MSG_NOSIGNAL);
        if (written <= 0) {
            if (written < 0 && errno == EINTR)
                continue;
            return false;
        }
        offset += static_cast<std::size_t>(written);
#endif
    }
    return true;
}

bool send_payload(ConnectionHandle connection, std::string_view payload)
{
    const auto frame = encode_frame(payload);
    return !frame.empty() && write_all(connection, frame);
}

std::optional<std::string> receive_payload(ConnectionHandle connection)
{
    std::array<std::uint8_t, 4> header{};
    if (!read_exact(connection, header.data(), header.size()))
        return std::nullopt;
    const std::uint32_t length = (static_cast<std::uint32_t>(header[0]) << 24U) |
                                 (static_cast<std::uint32_t>(header[1]) << 16U) |
                                 (static_cast<std::uint32_t>(header[2]) << 8U) |
                                 static_cast<std::uint32_t>(header[3]);
    if (length == 0 || length > max_frame_bytes)
        return std::nullopt;
    std::string payload(length, '\0');
    if (!read_exact(connection, reinterpret_cast<std::uint8_t*>(payload.data()), payload.size()))
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
};

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
        drain_queued_without_worker();
        return status_json();
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
        const auto state = state_.load();
        if (state == State::stopped)
            return;
        state_.store(State::draining);
        cancel_queued("daemon is draining");
        close_listener();
        close_clients();
        finish_if_safe();
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
        }
        result["criticalSections"] = critical_sections_.load();
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

    static std::uint64_t now_millis()
    {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch())
                .count());
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
            touch();
            const auto message = Json::parse(*payload, nullptr, false);
            if (message.is_discarded() || !message.is_object())
                break;
            const auto type = message.value("type", std::string{});
            const auto request_id = message.value("requestId", std::string{});
            if (request_id.empty())
                break;
            if (type == "cancel") {
                cancel_request(client, request_id);
                continue;
            }
            if (type != "request")
                break;
            const auto method = message.value("method", std::string{});
            if (method == "status") {
                client->send(result_event_json(request_id, true, status_json().dump()));
                continue;
            }
            if (method == "stop") {
                state_.store(State::draining);
                cancel_queued("daemon is draining");
                {
                    std::unique_lock lock(critical_mutex_);
                    critical_cv_.wait(lock, [this] { return critical_sections_.load() == 0; });
                }
                client->send(result_event_json(request_id, true, status_json().dump()));
                request_stop();
                break;
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
                    queued_.push_back(QueuedRequest{client, request_id});
                }
                continue;
            }
            client->send(result_event_json(request_id, false, "null",
                                           "daemon authoring worker is not attached"));
        }
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
        }
        if (removed) {
            Json event =
                Json::parse(result_event_json(request_id, false, "null", "request cancelled"));
            event["cancelled"] = true;
            client->send(event.dump());
        }
    }

    void drain_queued_without_worker()
    {
        std::vector<QueuedRequest> queued;
        {
            std::scoped_lock lock(queue_mutex_);
            queued.swap(queued_);
        }
        for (const auto& request : queued) {
            if (const auto client = request.client.lock())
                client->send(result_event_json(request.request_id, false, "null",
                                               "daemon authoring worker is not attached"));
        }
    }

    void cancel_queued(std::string_view reason)
    {
        std::vector<QueuedRequest> queued;
        {
            std::scoped_lock lock(queue_mutex_);
            queued.swap(queued_);
        }
        for (const auto& request : queued) {
            if (const auto client = request.client.lock()) {
                Json event =
                    Json::parse(result_event_json(request.request_id, false, "null", reason));
                event["cancelled"] = true;
                client->send(event.dump());
            }
        }
    }

    void request_stop()
    {
        const auto prior = state_.exchange(State::draining);
        if (prior == State::stopped)
            return;
        cancel_queued("daemon is draining");
        {
            std::unique_lock lock(critical_mutex_);
            critical_cv_.wait(lock, [this] { return critical_sections_.load() == 0; });
        }
        close_listener();
        close_clients();
        finish_if_safe();
    }

    void finish_if_safe()
    {
        if (state_.load() != State::draining || critical_sections_.load() != 0)
            return;
        state_.store(State::stopped);
#if !defined(_WIN32)
        std::error_code error;
        std::filesystem::remove(endpoint_.socket_path, error);
#endif
        state_cv_.notify_all();
    }

    void close_listener()
    {
        std::scoped_lock lock(listener_mutex_);
#if defined(_WIN32)
        if (pending_pipe_ != invalid_connection) {
            CancelIoEx(pending_pipe_, nullptr);
            CloseHandle(pending_pipe_);
            pending_pipe_ = invalid_connection;
        }
        if (lifetime_mutex_ != nullptr) {
            if (lifetime_mutex_owned_)
                ReleaseMutex(lifetime_mutex_);
            CloseHandle(lifetime_mutex_);
            lifetime_mutex_ = nullptr;
            lifetime_mutex_owned_ = false;
        }
#else
        if (listener_ >= 0) {
            ::shutdown(listener_, SHUT_RDWR);
            ::close(listener_);
            listener_ = -1;
        }
        if (lifetime_lock_ >= 0) {
            ::flock(lifetime_lock_, LOCK_UN);
            ::close(lifetime_lock_);
            lifetime_lock_ = -1;
        }
#endif
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
    std::mutex critical_mutex_;
    std::condition_variable critical_cv_;
    mutable std::mutex state_mutex_;
    std::condition_variable state_cv_;
    mutable std::mutex queue_mutex_;
    std::vector<QueuedRequest> queued_;
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

ConnectionHandle connect_endpoint(const Endpoint& endpoint)
{
#if defined(_WIN32)
    if (!WaitNamedPipeW(endpoint.pipe_name.c_str(), 100))
        return invalid_connection;
    const auto pipe = CreateFileW(endpoint.pipe_name.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
                                  nullptr, OPEN_EXISTING, 0, nullptr);
    return pipe == INVALID_HANDLE_VALUE ? invalid_connection : pipe;
#else
    const auto socket = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (socket < 0)
        return invalid_connection;
    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    const auto socket_text = endpoint.socket_path.string();
    std::memcpy(address.sun_path, socket_text.c_str(), socket_text.size() + 1);
    if (::connect(socket, reinterpret_cast<const sockaddr*>(&address), sizeof(address)) != 0) {
        ::close(socket);
        return invalid_connection;
    }
    return socket;
#endif
}

Json client_request(const BrokerContext& context, std::string_view method, std::string request_id,
                    std::optional<std::uint64_t> cancel_after_ms = std::nullopt)
{
    Endpoint endpoint;
    try {
        endpoint = make_endpoint(context);
    } catch (const std::exception& error) {
        return {{"ok", false}, {"error", error.what()}};
    }
    const auto connection = connect_endpoint(endpoint);
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
                          {"payload", Json::object()}};
    if (!send_payload(connection, request.dump())) {
        close_connection(connection);
        return {{"ok", false}, {"error", "failed to send daemon request"}};
    }
    if (cancel_after_ms) {
        std::this_thread::sleep_for(std::chrono::milliseconds(*cancel_after_ms));
        if (!send_payload(connection, cancellation_event_json(request_id))) {
            close_connection(connection);
            return {{"ok", false}, {"error", "failed to send daemon cancellation"}};
        }
    }
    const auto response = receive_payload(connection);
    close_connection(connection);
    if (!response)
        return {{"ok", false}, {"error", "daemon broker closed without a result"}};
    auto event = Json::parse(*response, nullptr, false);
    if (event.is_discarded() || event.value("type", std::string{}) != "result" ||
        event.value("requestId", std::string{}) != request_id)
        return {{"ok", false}, {"error", "daemon broker returned an invalid result frame"}};
    if ((method == "status" || method == "stop") && event.value("ok", false) &&
        event.contains("result") && event["result"].is_object())
        return event["result"];
    return event;
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

    auto current = client_request(context, "status", "ensure-status");
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

    const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
    const bool owner = startup_lock->try_acquire();
    bool spawned = false;
    if (owner) {
        current = client_request(context, "status", "ensure-status-owner");
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
        auto status = client_request(context, "status", "ensure-status-wait");
        if (status.value("running", false)) {
            status["started"] = spawned;
            return status;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return {{"ok", false},
            {"error", "daemon broker did not become reachable before startup timeout"}};
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
    else if (action == "serve-enter-critical")
        result = enter_local_critical_section();
    else if (action == "serve-leave-critical")
        result = leave_local_critical_section();
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
            result = client_request(*context, method, request_id, cancel_after);
        }
    } else if (action == "ensure")
        result = ensure_daemon(parsed, *context);
    else
        result = {{"ok", false}, {"error", "unknown daemon broker action"}};
    return write_response(result, response, response_capacity);
}
