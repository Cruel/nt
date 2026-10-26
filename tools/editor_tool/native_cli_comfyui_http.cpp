#include "native_cli_comfyui_http.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cerrno>
#include <cctype>
#include <cstdlib>
#include <stdexcept>
#include <regex>
#include <string_view>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <winhttp.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#endif

namespace noveltea::cli {
namespace {
using Json = nlohmann::ordered_json;
constexpr std::size_t max_response = 1024 * 1024;

struct Url {
    std::string scheme;
    std::string host;
    std::string port;
    std::string path;
};

Url parse_url(const std::string& value)
{
    // A bounded, conservative URL parser: no credentials, fragments or control characters.
    static const std::regex pattern(
        R"(^(https?)://(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9._-]+)(?::([0-9]{1,5}))?(/[a-zA-Z0-9._~!$&'()*+,;=:@%/-]*)?$)",
        std::regex::icase);
    std::smatch match;
    if (value.size() > 2048 || !std::regex_match(value, match, pattern))
        throw std::invalid_argument("ComfyUI server must be a valid HTTP(S) URL.");
    Url url{match[1], match[2], match[3], match[4]};
    std::transform(url.scheme.begin(), url.scheme.end(), url.scheme.begin(),
                   [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if (!url.port.empty()) {
        const int port = std::stoi(url.port);
        if (port <= 0 || port > 65535)
            throw std::invalid_argument("ComfyUI server must be a valid HTTP(S) URL.");
    } else {
        url.port = url.scheme == "https" ? "443" : "80";
    }
    if (url.path.empty())
        url.path = "/";
    if (url.host.starts_with('['))
        url.host = url.host.substr(1, url.host.size() - 2);
    return url;
}

std::string endpoint_path(const Url& url, const std::string& endpoint)
{
    // The legacy client resolves absolute API endpoints against the origin,
    // not the optional pathname of the server URL.
    (void)url;
    return endpoint;
}

ComfyUiHttpResult parse_json_response(const std::string& text, bool timed_out = false)
{
    if (text.empty() || text.size() > max_response)
        return {.timed_out = timed_out};
    // JSON_NOEXCEPTION=1 makes throwing JSON::parse abort the entire CLI.
    auto parsed = Json::parse(text, nullptr, false);
    if (parsed.is_discarded())
        return {};
    return {.ok = true, .body = std::move(parsed)};
}

#if defined(_WIN32)
std::wstring wide(const std::string& utf8)
{
    const auto count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                                           static_cast<int>(utf8.size()), nullptr, 0);
    if (count <= 0)
        return {};
    std::wstring result(static_cast<std::size_t>(count), L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()),
                        result.data(), count);
    return result;
}

struct WinHttpHandle {
    HINTERNET handle = nullptr;
    explicit WinHttpHandle(HINTERNET value) : handle(value) {}
    ~WinHttpHandle()
    {
        if (handle)
            WinHttpCloseHandle(handle);
    }
    explicit operator bool() const { return handle != nullptr; }
};

ComfyUiHttpResult fetch(const Url& url, const std::string& endpoint, int timeout)
{
    WinHttpHandle session(WinHttpOpen(L"NovelTea/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                                      WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session)
        return {};
    WinHttpSetTimeouts(session.handle, timeout, timeout, timeout, timeout);
    WinHttpHandle connection(WinHttpConnect(session.handle, wide(url.host).c_str(),
                                            static_cast<INTERNET_PORT>(std::stoi(url.port)), 0));
    if (!connection)
        return {};
    WinHttpHandle request(WinHttpOpenRequest(connection.handle, L"GET",
                                             wide(endpoint_path(url, endpoint)).c_str(), nullptr,
                                             WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                             url.scheme == "https" ? WINHTTP_FLAG_SECURE : 0));
    if (!request ||
        !WinHttpSendRequest(request.handle, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
        !WinHttpReceiveResponse(request.handle, nullptr))
        return {.timed_out = GetLastError() == ERROR_WINHTTP_TIMEOUT};
    DWORD status = 0, status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request.handle, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size,
                             WINHTTP_NO_HEADER_INDEX) ||
        status < 200 || status >= 300)
        return {};
    std::string bytes;
    std::array<char, 8192> block{};
    for (;;) {
        DWORD available = 0, read = 0;
        if (!WinHttpQueryDataAvailable(request.handle, &available))
            return {};
        if (available == 0)
            break;
        if (bytes.size() + available > max_response)
            return {};
        while (available) {
            const auto requested =
                static_cast<DWORD>(std::min<std::size_t>(available, block.size()));
            if (!WinHttpReadData(request.handle, block.data(), requested, &read) || read == 0)
                return {};
            bytes.append(block.data(), read);
            available -= read;
        }
    }
    return parse_json_response(bytes);
}
#else
struct Socket {
    int fd = -1;
    explicit Socket(int value) : fd(value) {}
    ~Socket()
    {
        if (fd >= 0)
            close(fd);
    }
};

std::string decoded_body(std::string_view bytes)
{
    const auto header_end = bytes.find("\r\n\r\n");
    if (header_end == std::string_view::npos)
        return {};
    const auto headers = bytes.substr(0, header_end);
    if (!headers.starts_with("HTTP/1.1 2") && !headers.starts_with("HTTP/1.0 2"))
        return {};
    bytes.remove_prefix(header_end + 4);
    auto lower = std::string(headers);
    std::transform(lower.begin(), lower.end(), lower.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    if (lower.find("transfer-encoding: chunked") == std::string::npos)
        return std::string(bytes);
    std::string output;
    while (true) {
        const auto delimiter = bytes.find("\r\n");
        if (delimiter == std::string_view::npos)
            return {};
        const auto size_text =
            bytes.substr(0, bytes.find(';') < delimiter ? bytes.find(';') : delimiter);
        std::size_t size = 0;
        auto [end, error] =
            std::from_chars(size_text.data(), size_text.data() + size_text.size(), size, 16);
        if (error != std::errc{} || end != size_text.data() + size_text.size())
            return {};
        bytes.remove_prefix(delimiter + 2);
        if (size == 0)
            return output;
        if (size > max_response - output.size() || size > bytes.size() || bytes.size() - size < 2 ||
            bytes.substr(size, 2) != "\r\n")
            return {};
        output.append(bytes.substr(0, size));
        bytes.remove_prefix(size + 2);
    }
}

ComfyUiHttpResult fetch_plain_http(const Url& url, const std::string& endpoint, int timeout)
{
    struct addrinfo hints {};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    struct addrinfo* addresses = nullptr;
    if (getaddrinfo(url.host.c_str(), url.port.c_str(), &hints, &addresses) != 0)
        return {};
    std::string bytes;
    bool received = false;
    bool timeout_hit = false;
    for (auto* address = addresses; address; address = address->ai_next) {
        Socket sock(socket(address->ai_family, address->ai_socktype, address->ai_protocol));
        if (sock.fd < 0)
            continue;
        timeval interval{timeout / 1000, (timeout % 1000) * 1000};
        setsockopt(sock.fd, SOL_SOCKET, SO_RCVTIMEO, &interval, sizeof(interval));
        setsockopt(sock.fd, SOL_SOCKET, SO_SNDTIMEO, &interval, sizeof(interval));
        const auto flags = fcntl(sock.fd, F_GETFL, 0);
        if (flags < 0 || fcntl(sock.fd, F_SETFL, flags | O_NONBLOCK) < 0)
            continue;
        if (connect(sock.fd, address->ai_addr, address->ai_addrlen) != 0) {
            if (errno != EINPROGRESS)
                continue;
            fd_set writers;
            FD_ZERO(&writers);
            FD_SET(sock.fd, &writers);
            timeval connect_timeout = interval;
            if (select(sock.fd + 1, nullptr, &writers, nullptr, &connect_timeout) != 1) {
                timeout_hit = true;
                continue;
            }
            int socket_error = 0;
            socklen_t socket_error_length = sizeof(socket_error);
            if (getsockopt(sock.fd, SOL_SOCKET, SO_ERROR, &socket_error, &socket_error_length) !=
                    0 ||
                socket_error != 0)
                continue;
        }
        if (fcntl(sock.fd, F_SETFL, flags) < 0)
            continue;
        const auto host = url.host.find(':') != std::string::npos ? "[" + url.host + "]" : url.host;
        const std::string request = "GET " + endpoint_path(url, endpoint) +
                                    " HTTP/1.1\r\nHost: " + host + ":" + url.port +
                                    "\r\nAccept: application/json\r\nConnection: close\r\n\r\n";
        std::size_t offset = 0;
        while (offset < request.size()) {
#if defined(MSG_NOSIGNAL)
            const auto count =
                send(sock.fd, request.data() + offset, request.size() - offset, MSG_NOSIGNAL);
#else
            const auto count = send(sock.fd, request.data() + offset, request.size() - offset, 0);
#endif
            if (count <= 0)
                break;
            offset += static_cast<std::size_t>(count);
        }
        if (offset != request.size())
            continue;
        std::array<char, 8192> block{};
        while (bytes.size() <= max_response + 8192) {
            const auto count = recv(sock.fd, block.data(), block.size(), 0);
            if (count == 0) {
                received = true;
                break;
            }
            if (count < 0) {
                timeout_hit = errno == EAGAIN || errno == EWOULDBLOCK || errno == ETIMEDOUT;
                break;
            }
            bytes.append(block.data(), static_cast<std::size_t>(count));
        }
        break;
    }
    freeaddrinfo(addresses);
    if (!received || bytes.size() > max_response + 8192)
        return {.timed_out = timeout_hit};
    return parse_json_response(decoded_body(bytes));
}

// On POSIX, the OS curl client supplies certificate validation for remote HTTPS.
// HTTP remains self-contained and never depends on the availability of curl.
ComfyUiHttpResult fetch_https(const Url& url, const std::string& endpoint, int timeout)
{
    int pipefd[2];
    if (pipe(pipefd) != 0)
        return {};
    const auto url_text =
        "https://" + (url.host.find(':') != std::string::npos ? "[" + url.host + "]" : url.host) +
        ":" + url.port + endpoint_path(url, endpoint);
    const auto seconds = std::to_string(std::max(1, (timeout + 999) / 1000));
    const auto pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        return {};
    }
    if (pid == 0) {
        close(pipefd[0]);
        dup2(pipefd[1], STDOUT_FILENO);
        close(pipefd[1]);
        const auto sink = open("/dev/null", O_WRONLY);
        if (sink >= 0) {
            dup2(sink, STDERR_FILENO);
            close(sink);
        }
        execlp("curl", "curl", "--silent", "--show-error", "--fail", "--location", "--max-time",
               seconds.c_str(), "--max-filesize", "1048576", "--proto", "=https", "--proto-redir",
               "=https", "--", url_text.c_str(), static_cast<char*>(nullptr));
        _exit(127);
    }
    close(pipefd[1]);
    std::string bytes;
    std::array<char, 8192> block{};
    ssize_t n;
    while ((n = read(pipefd[0], block.data(), block.size())) > 0 && bytes.size() <= max_response)
        bytes.append(block.data(), static_cast<std::size_t>(n));
    close(pipefd[0]);
    if (bytes.size() > max_response)
        kill(pid, SIGKILL);
    int status = 0;
    waitpid(pid, &status, 0);
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
        return {.timed_out = WIFEXITED(status) && WEXITSTATUS(status) == 28};
    return parse_json_response(bytes);
}

ComfyUiHttpResult fetch(const Url& url, const std::string& endpoint, int timeout)
{
    return url.scheme == "https" ? fetch_https(url, endpoint, timeout)
                                 : fetch_plain_http(url, endpoint, timeout);
}
#endif
} // namespace

ComfyUiHttpResult comfyui_get_json(const std::string& server, const std::string& endpoint,
                                   int timeout_ms)
{
    const auto url = parse_url(server);
    return fetch(url, endpoint, std::clamp(timeout_ms, 1, 300000));
}

std::string comfyui_server_identity(const std::string& server)
{
    auto url = parse_url(server);
    std::transform(url.host.begin(), url.host.end(), url.host.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    const auto host = url.host.find(':') == std::string::npos ? url.host : "[" + url.host + "]";
    const bool default_port =
        (url.scheme == "http" && url.port == "80") || (url.scheme == "https" && url.port == "443");
    while (!url.path.empty() && url.path.back() == '/')
        url.path.pop_back();
    return url.scheme + "://" + host + (default_port ? "" : ":" + url.port) + url.path;
}
} // namespace noveltea::cli
