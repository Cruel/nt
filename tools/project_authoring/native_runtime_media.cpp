#include "native_runtime_media.hpp"
#include "source_authority.hpp"
#include "tooling_native_c.h"

#include <noveltea/core/player_bootstrap.hpp>

#include <algorithm>
#include <chrono>
#include <cerrno>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <regex>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <csignal>
#else
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <csignal>
#endif

namespace noveltea::cli {
namespace {
namespace fs = std::filesystem;
using Json = nlohmann::json;

struct VideoError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

[[nodiscard]] std::string digest(std::string_view bytes)
{
    return core::sha256_hex(std::as_bytes(std::span(bytes.data(), bytes.size())));
}

[[nodiscard]] std::string read(const fs::path& path, std::uintmax_t limit)
{
    if (!fs::is_regular_file(path) || fs::file_size(path) > limit)
        throw VideoError("Video input/output is missing or exceeds the native media limit.");
    std::ifstream input(path, std::ios::binary);
    if (!input)
        throw VideoError("Cannot read video input/output.");
    std::string bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
    if (input.bad())
        throw VideoError("Could not finish reading video input/output.");
    return bytes;
}

void write(const fs::path& path, std::string_view bytes)
{
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!output)
        throw VideoError("Could not write temporary media snapshot.");
}

[[nodiscard]] bool safe_relative(std::string_view source)
{
    if (source.empty() || source.front() == '/' || source.find('\\') != source.npos ||
        source.find(':') != source.npos)
        return false;
    for (const auto& part : fs::path(source))
        if (part == "." || part == ".." || part.empty())
            return false;
    return true;
}

[[nodiscard]] fs::path source_path(const fs::path& root, std::string_view relative)
{
    if (!safe_relative(relative))
        throw VideoError("Video Asset source is not a safe relative Project path.");
    auto path = root;
    for (const auto& component : fs::path(relative)) {
        path /= component;
        if (fs::is_symlink(fs::symlink_status(path)))
            throw VideoError("Video Asset source traverses a symlink.");
    }
    return path;
}

struct Output {
    std::string stdout_text;
    std::string stderr_text;
};

[[nodiscard]] bool ffmpeg_output_limit_exceeded(const fs::path& out, const fs::path& err)
{
    for (const auto& file : {out, err}) {
        std::error_code error;
        const auto bytes = fs::file_size(file, error);
        if (!error && bytes > 64ull * 1024 * 1024)
            return true;
    }
    return false;
}

[[nodiscard]] std::string ffmpeg_binary()
{
    const auto* override = std::getenv("NOVELTEA_FFMPEG");
    if (override && *override)
        return override;
    // The shipped native CLI carries FFmpeg in its private installation
    // tree. Looking up only PATH silently selects a system binary (or none)
    // even though 'noveltea media-tool check' succeeds after relocation.
    try {
        fs::path running;
#if defined(_WIN32)
        std::wstring buffer(32768, L'\0');
        const auto count =
            GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (count && count < buffer.size()) {
            buffer.resize(count);
            running = fs::path(buffer);
        }
#elif defined(__APPLE__)
        std::uint32_t size = 0;
        _NSGetExecutablePath(nullptr, &size);
        std::string buffer(size, '\0');
        if (_NSGetExecutablePath(buffer.data(), &size) == 0)
            running = buffer.c_str();
#else
        running = "/proc/self/exe";
#endif
        if (!running.empty()) {
            const auto directory = fs::canonical(running).parent_path();
            const auto installation =
                directory.filename() == "bin" ? directory.parent_path() : directory;
#if defined(_WIN32)
            const auto bundled = installation / "tools/ffmpeg/bin/ffmpeg.exe";
#else
            const auto bundled = installation / "tools/ffmpeg/bin/ffmpeg";
#endif
            if (fs::is_regular_file(bundled)) {
                const auto utf8 = bundled.u8string();
                return {utf8.begin(), utf8.end()};
            }
        }
    } catch (const fs::filesystem_error&) {
        // Developer/test binaries can still use a pinned tool on PATH.
    }
    return "ffmpeg";
}

[[nodiscard]] fs::path absolute_ffmpeg_binary()
{
    const auto ffmpeg = ffmpeg_binary();
    const auto configured = fs::path(std::u8string(ffmpeg.begin(), ffmpeg.end()));
    if (configured.is_absolute() && fs::is_regular_file(configured))
        return fs::canonical(configured);
    if (configured.has_parent_path())
        throw VideoError("FFmpeg media tool must be an absolute executable or available on PATH.");
    const auto* environment = std::getenv("PATH");
    std::istringstream paths{environment ? environment : ""};
    std::string directory;
#if defined(_WIN32)
    constexpr char separator = ';';
    const std::string executable = configured.string() + ".exe";
#else
    constexpr char separator = ':';
    const std::string executable = configured.string();
#endif
    while (std::getline(paths, directory, separator)) {
        const auto candidate =
            fs::path(std::u8string(directory.begin(), directory.end())) / executable;
        if (fs::is_regular_file(candidate))
            return fs::canonical(candidate);
    }
    throw VideoError("The configured FFmpeg media tool cannot be found.");
}

#if defined(_WIN32)
std::wstring quote(std::wstring_view input)
{
    std::wstring output = L"\"";
    unsigned slashes = 0;
    for (const auto ch : input) {
        if (ch == L'\\') {
            ++slashes;
            continue;
        }
        if (ch == L'"')
            output.append(slashes * 2 + 1, L'\\');
        else
            output.append(slashes, L'\\');
        slashes = 0;
        output.push_back(ch);
    }
    output.append(slashes * 2, L'\\');
    return output + L"\"";
}
#endif

// Invoke the existing FFmpeg host tool without a shell, so authored file names
// and filter expressions never become executable shell input. Both outputs are
// bounded after completion, and cancellation kills a running encoder.
[[nodiscard]] Output run_ffmpeg(const std::vector<std::string>& args, const fs::path& dir,
                                const std::function<bool()>& cancelled)
{
    const auto out_path = dir / "ffmpeg.stdout";
    const auto err_path = dir / "ffmpeg.stderr";
    const auto binary = ffmpeg_binary();
#if defined(_WIN32)
    HANDLE out = CreateFileW(out_path.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                             CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    HANDLE err = CreateFileW(err_path.wstring().c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr,
                             CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (out == INVALID_HANDLE_VALUE || err == INVALID_HANDLE_VALUE)
        throw VideoError("Cannot create FFmpeg diagnostic output.");
    SetHandleInformation(out, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    SetHandleInformation(err, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdOutput = out;
    startup.hStdError = err;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    std::wstring command = quote(fs::path(std::u8string(binary.begin(), binary.end())).wstring());
    for (const auto& arg : args)
        command += L" " + quote(fs::path(std::u8string(arg.begin(), arg.end())).wstring());
    PROCESS_INFORMATION process{};
    const bool started = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process);
    CloseHandle(out);
    CloseHandle(err);
    if (!started)
        throw VideoError("Cannot launch FFmpeg native media tool.");
    bool aborted = false;
    const auto until = std::chrono::steady_clock::now() + std::chrono::minutes(3);
    while (WaitForSingleObject(process.hProcess, 100) == WAIT_TIMEOUT) {
        if ((cancelled && cancelled()) || std::chrono::steady_clock::now() > until ||
            ffmpeg_output_limit_exceeded(out_path, err_path)) {
            TerminateProcess(process.hProcess, 1);
            aborted = true;
            break;
        }
    }
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD status = 1;
    GetExitCodeProcess(process.hProcess, &status);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    if (aborted)
        throw VideoError("Video preparation cancelled or exceeded its time limit.");
    if (status != 0)
        throw VideoError("FFmpeg video preparation failed: " +
                         read(err_path, 64 * 1024 * 1024).substr(0, 2048));
#else
    const auto child = ::fork();
    if (child < 0)
        throw VideoError("Cannot fork FFmpeg native media tool.");
    if (child == 0) {
        const int out = ::open(out_path.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0600);
        const int err = ::open(err_path.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0600);
        const int in = ::open("/dev/null", O_RDONLY);
        if (out < 0 || err < 0 || in < 0 || ::dup2(out, STDOUT_FILENO) < 0 ||
            ::dup2(err, STDERR_FILENO) < 0 || ::dup2(in, STDIN_FILENO) < 0)
            _exit(127);
        ::close(out);
        ::close(err);
        ::close(in);
        std::vector<char*> argv;
        argv.push_back(const_cast<char*>(binary.c_str()));
        for (const auto& arg : args)
            argv.push_back(const_cast<char*>(arg.c_str()));
        argv.push_back(nullptr);
        ::execvp(binary.c_str(), argv.data());
        _exit(127);
    }
    int status = 0;
    bool aborted = false;
    const auto until = std::chrono::steady_clock::now() + std::chrono::minutes(3);
    for (;;) {
        const auto result = ::waitpid(child, &status, WNOHANG);
        if (result == child)
            break;
        if (result < 0) {
            if (errno == EINTR)
                continue;
            ::kill(child, SIGKILL);
            (void)::waitpid(child, &status, 0);
            throw VideoError("FFmpeg process could not be reaped.");
        }
        if ((cancelled && cancelled()) || std::chrono::steady_clock::now() > until ||
            ffmpeg_output_limit_exceeded(out_path, err_path)) {
            ::kill(child, SIGKILL);
            aborted = true;
            ::waitpid(child, &status, 0);
            break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (aborted)
        throw VideoError("Video preparation cancelled or exceeded its time limit.");
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
        throw VideoError("FFmpeg video preparation failed: " +
                         read(err_path, 64 * 1024 * 1024).substr(0, 2048));
#endif
    return {read(out_path, 64 * 1024 * 1024), read(err_path, 64 * 1024 * 1024)};
}

struct Sample {
    double time_ms;
    double duration_ms;
};

[[nodiscard]] std::vector<Sample> samples_from_ffmpeg(std::string_view log)
{
    std::vector<Sample> result;
    std::istringstream stream{std::string(log)};
    std::string line;
    while (std::getline(stream, line)) {
        if (line.find("Parsed_showinfo_") == line.npos)
            continue;
        if (line.find("pts_time:") == line.npos)
            continue;
        const auto extract = [&](std::string_view key) -> double {
            const auto pos = line.find(key);
            if (pos == line.npos)
                return -1;
            const auto begin = line.find_first_not_of(" \t", pos + key.size());
            if (begin == line.npos)
                return -1;
            const auto end = line.find_first_of(" \t\r", begin);
            try {
                return std::stod(line.substr(begin, end - begin)) * 1000.0;
            } catch (...) {
                return -1;
            }
        };
        const double time_ms = extract("pts_time:");
        const double duration = extract("duration_time:");
        if (!std::isfinite(time_ms) || time_ms < 0 || (duration >= 0 && !std::isfinite(duration)) ||
            (!result.empty() && time_ms <= result.back().time_ms))
            throw VideoError("Video contains invalid or nonmonotonic presentation timestamps.");
        result.push_back({time_ms, duration});
        if (result.size() > 65536)
            throw VideoError("Video exceeds the native sample limit.");
    }
    if (result.empty())
        throw VideoError("FFmpeg did not report any decoded video samples.");
    return result;
}

struct ColorConversion {
    std::vector<std::string> filters;
    bool reduced_precision = false;
};

[[nodiscard]] ColorConversion source_color_conversion(const std::string& log)
{
    std::smatch metadata;
    std::string matrix, primaries, transfer;
    if (std::regex_search(
            log, metadata,
            std::regex(R"(color_space:(\S+)\s+color_primaries:(\S+)\s+color_trc:(\S+))"))) {
        matrix = metadata[1];
        primaries = metadata[2];
        transfer = metadata[3];
    }
    if (matrix.empty() || matrix == "unknown" || matrix == "unspecified" || primaries.empty() ||
        primaries == "unknown" || primaries == "unspecified" || transfer.empty() ||
        transfer == "unknown" || transfer == "unspecified") {
        std::istringstream lines(log);
        std::string line;
        while (std::getline(lines, line)) {
            if (line.find("Stream #") == line.npos || line.find("Video:") == line.npos)
                continue;
            std::smatch stream;
            if (std::regex_search(
                    line, stream,
                    std::regex(R"(\b(?:tv|pc),\s*([^/,\s]+)/([^/,\s]+)/([^,\s\)]+))"))) {
                if (matrix.empty() || matrix == "unknown" || matrix == "unspecified")
                    matrix = stream[1];
                if (primaries.empty() || primaries == "unknown" || primaries == "unspecified")
                    primaries = stream[2];
                if (transfer.empty() || transfer == "unknown" || transfer == "unspecified")
                    transfer = stream[3];
            }
            break;
        }
    }
    const bool hdr = transfer == "smpte2084" || transfer == "arib-std-b67";
    std::smatch decoded_format;
    const auto fmt = std::regex_search(log, decoded_format, std::regex(R"(\bfmt:(\S+))"))
                         ? decoded_format[1].str()
                         : std::string{};
    const bool reduced =
        hdr ||
        std::regex_search(fmt, std::regex(R"((?:p0?1[026]|p1[026]|p0?9|p0?1[24]|10le|12le|16le))",
                                          std::regex::icase)) ||
        std::regex_search(log,
                          std::regex(R"((?:smpte2084|arib-std-b67|p010le|p016le|yuv\w*p1[02-6]le))",
                                     std::regex::icase));
    if (hdr) {
        if (matrix != "bt2020nc" || primaries != "bt2020")
            throw VideoError(
                "HDR video requires BT.2020 primaries and nonconstant luminance matrix.");
        return {{"zscale=t=linear:m=gbr:npl=100", "format=gbrpf32le",
                 "tonemap=tonemap=hable:desat=0", "zscale=p=bt709:t=bt709:m=bt709:r=tv",
                 "format=yuv420p"},
                true};
    }
    std::string input;
    if (matrix == "smpte170m" || matrix == "bt470bg" || matrix == "smpte240m")
        input = matrix;
    else if (matrix == "bt2020nc" && transfer == "bt2020-10")
        input = "bt2020";
    if (!input.empty())
        return {{"colorspace=iall=" + input + ":all=bt709:format=yuv420p:dither=fsb"}, reduced};
    return {{}, reduced};
}

[[nodiscard]] std::string seconds(std::int64_t milliseconds)
{
    std::ostringstream out;
    out << std::fixed << std::setprecision(6) << (milliseconds / 1000.0);
    auto result = out.str();
    while (result.back() == '0')
        result.pop_back();
    if (result.back() == '.')
        result.pop_back();
    return result;
}

[[nodiscard]] std::string segment(std::string value)
{
    for (auto& ch : value)
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
              ch == '.' || ch == '_' || ch == '-'))
            ch = '-';
    return value;
}

[[nodiscard]] bool source_has_alpha(std::string_view diagnostics)
{
    static const std::regex format(R"(\bfmt:(\w+))");
    const std::string text(diagnostics);
    std::sregex_iterator current(text.begin(), text.end(), format), end;
    bool found = false;
    for (; current != end; ++current) {
        found = true;
        const auto name = (*current)[1].str();
        if (!(name.starts_with("yuva") || name.starts_with("gbrap") || name == "rgba" ||
              name == "bgra" || name == "argb" || name == "abgr" || name.starts_with("ya") ||
              name == "pal8"))
            return false;
    }
    return found;
}

[[nodiscard]] Json native_alpha_encode(const Json& request)
{
    const auto serialized = request.dump();
    std::vector<std::uint8_t> response(256 * 1024);
    const auto size = noveltea_tooling_encode_alpha_webp_json(
        reinterpret_cast<const std::uint8_t*>(serialized.data()), serialized.size(),
        response.data(), response.size());
    if (size > response.size())
        throw VideoError("Native alpha encoder response exceeded its bounded output.");
    return Json::parse(response.begin(), response.begin() + static_cast<std::ptrdiff_t>(size));
}

[[nodiscard]] Json prepare_video(const Json& request, const Json& revisions, const fs::path& root,
                                 Json& artifact, const std::function<bool()>& cancelled)
{
    const auto relative = request.at("sourcePath").get<std::string>();
    if (!revisions.contains(relative))
        throw VideoError("Video source is missing an admitted physical revision.");
    const auto input = source_path(root, relative);
    const auto source = read(input, 512ull * 1024 * 1024);
    if (!revisions.at(relative).is_string() ||
        !authoring::source_revision_matches(source, revisions.at(relative).get<std::string>()))
        throw VideoError("Video source changed after Project admission.");
    const auto& canvas = request.at("canvas");
    const int width = canvas.at("width").get<int>();
    const int height = canvas.at("height").get<int>();
    if (width < 1 || height < 1 || width > 10000 || height > 10000)
        throw VideoError("Video canvas exceeds the native decoder's bounds.");
    const Json range = request.value("sourceRange", Json(nullptr));
    const Json sampling = request.value("frameSampling", Json{{"mode", "source"}});
    const nlohmann::ordered_json ordered_canvas{{"width", width}, {"height", height}};
    nlohmann::ordered_json ordered_range = nullptr;
    if (!range.is_null())
        ordered_range = {{"startMs", range.at("startMs")}, {"endMs", range.at("endMs")}};
    nlohmann::ordered_json ordered_sampling = {{"mode", sampling.at("mode")}};
    if (sampling.contains("percent"))
        ordered_sampling["percent"] = sampling.at("percent");
    if (sampling.contains("fps"))
        ordered_sampling["fps"] = {{"numerator", sampling.at("fps").at("numerator")},
                                   {"denominator", sampling.at("fps").at("denominator")}};
    nlohmann::ordered_json key_data{{"animationId", request.at("animationId")},
                                    {"motionId", request.at("motionId")},
                                    {"canvas", ordered_canvas},
                                    {"sourceRange", ordered_range},
                                    {"sampling", ordered_sampling},
                                    {"representationVersion", 5},
                                    {"toolRelease", "ffmpeg-r3"}};
    const auto key = digest(source + std::string(1, '\0') + key_data.dump());
    const auto parent = root / ".noveltea/build/prepared-media";
    for (const auto& candidate : {root / ".noveltea", root / ".noveltea/build", parent}) {
        std::error_code error;
        if (fs::is_symlink(fs::symlink_status(candidate, error)))
            throw VideoError("Prepared media staging directory traverses a symlink.");
    }
    fs::create_directories(parent);
    fs::path stage;
    const auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    bool created = false;
    for (int attempt = 0; attempt < 32 && !created; ++attempt) {
        stage =
            parent / (key + ".partial-" + std::to_string(nonce) + "-" + std::to_string(attempt));
        created = fs::create_directory(stage);
    }
    if (!created)
        throw VideoError("Unable to reserve an isolated prepared media staging directory.");
    const auto destination = parent / key;
    struct Cleanup {
        fs::path path;
        ~Cleanup()
        {
            std::error_code ignored;
            fs::remove_all(path, ignored);
        }
    } cleanup{stage};
    const auto snapshot = stage / "source.snapshot";
    write(snapshot, source);
    const auto version = run_ffmpeg({"-version"}, stage, cancelled).stdout_text;
    if (!version.starts_with("ffmpeg version 9.0.1"))
        throw VideoError("Video preparation requires NovelTea's pinned FFmpeg 9.0.1 (ffmpeg-r3).");
    const auto probe = run_ffmpeg({"-hide_banner", "-i", snapshot.string(), "-map", "0:v:0", "-an",
                                   "-sn", "-dn", "-vf", "setpts=PTS-STARTPTS,showinfo", "-fps_mode",
                                   "passthrough", "-f", "null", "-"},
                                  stage, cancelled);
    const auto source_samples = samples_from_ffmpeg(probe.stderr_text);
    const auto color = source_color_conversion(probe.stderr_text);
    std::size_t first = 0, end = source_samples.size();
    double endpoint = source_samples.back().time_ms + source_samples.back().duration_ms;
    if (source_samples.back().duration_ms <= 0 && source_samples.size() > 1)
        endpoint = source_samples.back().time_ms + source_samples.back().time_ms -
                   source_samples[source_samples.size() - 2].time_ms;
    std::string filter = "setpts=PTS-STARTPTS";
    if (!range.is_null()) {
        const auto start = range.at("startMs").get<std::int64_t>();
        const auto stop = range.at("endMs").get<std::int64_t>();
        if (start < 0 || stop <= start)
            throw VideoError("Video motion has an invalid clip range.");
        while (first + 1 < source_samples.size() && source_samples[first + 1].time_ms <= start)
            ++first;
        end = first + 1;
        while (end < source_samples.size() && source_samples[end].time_ms < stop)
            ++end;
        endpoint = stop - start;
        filter += ",select='between(n\\," + std::to_string(first) + "\\," +
                  std::to_string(end - 1) + ")',setpts='if(eq(N\\,0)\\,0\\,PTS-" + seconds(start) +
                  "/TB)'";
    }
    const auto mode = sampling.at("mode").get<std::string>();
    if (mode == "target-fps") {
        const auto fps = sampling.at("fps");
        filter += ",fps=fps=" + std::to_string(fps.at("numerator").get<int>()) + "/" +
                  std::to_string(fps.at("denominator").get<int>()) + ":round=near";
        filter += ",trim=end=" + seconds(static_cast<std::int64_t>(std::round(endpoint)));
    } else if (mode == "retain-percent") {
        const int count = static_cast<int>(end - first);
        const double percent = sampling.at("percent").get<double>();
        const int kept =
            std::min(count, std::max(1, static_cast<int>(std::round(count * percent / 100))));
        if (kept == 1)
            filter += ",select='eq(n\\,0)'";
        else if (kept < count) {
            const auto last = count - 1;
            const auto intervals = kept - 1;
            filter += ",select='eq(n\\,0)+eq(n\\," + std::to_string(last) + ")+gt(floor(n*" +
                      std::to_string(intervals) + "/" + std::to_string(last) + ")\\,floor((n-1)*" +
                      std::to_string(intervals) + "/" + std::to_string(last) + "))'";
        }
    } else if (mode != "source") {
        throw VideoError("Video motion uses an unsupported frame sampling mode.");
    }
    const auto semantic_filter = filter;
    for (const auto& color_filter : color.filters)
        filter += "," + color_filter;
    // A private prepared video always has an opaque BT.709 YUV420P color stream.
    filter += ",scale=" + std::to_string(width) + ":" + std::to_string(height) +
              ":force_original_aspect_ratio=decrease:out_color_matrix=bt709,pad=" +
              std::to_string(width) + ":" + std::to_string(height) +
              ":(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p,showinfo";
    const auto stage_video = stage / "opaque.webm";
    (void)run_ffmpeg({"-hide_banner",
                      "-y",
                      "-i",
                      snapshot.string(),
                      "-map",
                      "0:v:0",
                      "-an",
                      "-sn",
                      "-dn",
                      "-vf",
                      filter,
                      "-map_metadata",
                      "-1",
                      "-c:v",
                      "libvpx-vp9",
                      "-pix_fmt",
                      "yuv420p",
                      "-color_primaries",
                      "bt709",
                      "-color_trc",
                      "bt709",
                      "-colorspace",
                      "bt709",
                      "-color_range",
                      "tv",
                      "-lossless",
                      "1",
                      "-threads",
                      "1",
                      "-row-mt",
                      "0",
                      "-lag-in-frames",
                      "0",
                      "-auto-alt-ref",
                      "0",
                      "-g",
                      "30",
                      "-fps_mode",
                      "vfr",
                      "-enc_time_base",
                      "filter",
                      "-flags:v",
                      "+bitexact",
                      "-fflags",
                      "+bitexact",
                      stage_video.string()},
                     stage, cancelled);
    const auto verification =
        run_ffmpeg({"-hide_banner", "-i", stage_video.string(), "-map", "0:v:0", "-an", "-sn",
                    "-dn", "-vf", "showinfo", "-fps_mode", "passthrough", "-f", "null", "-"},
                   stage, cancelled);
    const auto verified = samples_from_ffmpeg(verification.stderr_text);
    if (std::round(verified.front().time_ms) != 0 || verified.size() > 65536 ||
        (mode == "source" && verified.size() != end - first))
        throw VideoError("Packaged VP9 samples disagree with source timing.");
    Json frames = Json::array();
    std::vector<std::uint64_t> durations;
    for (std::size_t index = 0; index < verified.size(); ++index) {
        const auto from = static_cast<std::int64_t>(std::round(verified[index].time_ms));
        const auto to = index + 1 < verified.size()
                            ? static_cast<std::int64_t>(std::round(verified[index + 1].time_ms))
                            : static_cast<std::int64_t>(std::round(endpoint));
        if (to <= from)
            throw VideoError("Prepared VP9 frame duration is invalid.");
        frames.push_back({{"durationMs", to - from}});
        durations.push_back(static_cast<std::uint64_t>(to - from));
    }
    const auto browser_bytes = read(stage_video, 128ull * 1024 * 1024);
    if (browser_bytes.empty())
        throw VideoError("Prepared VP9 output is empty.");
    std::vector<std::string> decoder;
    if (fs::path(relative).extension() == ".webm") {
        const auto header = run_ffmpeg({"-hide_banner", "-i", snapshot.string(), "-map", "0:v:0",
                                        "-frames:v", "0", "-f", "null", "-"},
                                       stage, cancelled)
                                .stderr_text;
        const std::regex codec_pattern(R"(Video: (vp8|vp9)\b)");
        std::smatch match;
        if (!std::regex_search(header, match, codec_pattern))
            throw VideoError("Transparent WebM must contain a supported VP8/VP9 video stream.");
        decoder = {"-c:v", match[1] == "vp8" ? "libvpx" : "libvpx-vp9"};
    }
    std::vector<std::string> alpha_probe{"-hide_banner"};
    alpha_probe.insert(alpha_probe.end(), decoder.begin(), decoder.end());
    alpha_probe.insert(alpha_probe.end(), {"-i", snapshot.string(), "-map", "0:v:0", "-an", "-sn",
                                           "-dn", "-vf", "setpts=PTS-STARTPTS,showinfo",
                                           "-fps_mode", "passthrough", "-f", "null", "-"});
    const auto alpha_diagnostics = run_ffmpeg(alpha_probe, stage, cancelled).stderr_text;
    const auto has_alpha = source_has_alpha(alpha_diagnostics);
    if (!has_alpha && std::regex_search(alpha_diagnostics, std::regex(R"(alpha_mode\s*:\s*1\b)")))
        throw VideoError("FFmpeg decoder discarded the declared source alpha channel.");
    bool encoded_alpha = false;
    const auto stage_alpha = stage / "alpha.webp";
    if (has_alpha) {
        const auto alpha_filter =
            semantic_filter + ",format=rgba,alphaextract,scale=" + std::to_string(width) + ":" +
            std::to_string(height) +
            ":force_original_aspect_ratio=decrease:flags=bicubic,pad=" + std::to_string(width) +
            ":" + std::to_string(height) +
            ":(ow-iw)/2:(oh-ih)/2:color=black,format=gray,format=rgba," +
            "geq=r=255:g=255:b=255:a=r(X\\,Y),showinfo";
        std::vector<std::string> arguments{"-nostdin", "-hide_banner", "-y"};
        arguments.insert(arguments.end(), decoder.begin(), decoder.end());
        arguments.insert(arguments.end(), {"-i",
                                           snapshot.string(),
                                           "-map",
                                           "0:v:0",
                                           "-an",
                                           "-sn",
                                           "-dn",
                                           "-vf",
                                           alpha_filter,
                                           "-fps_mode",
                                           "passthrough",
                                           "-enc_time_base",
                                           "1:1000",
                                           "-c:v",
                                           "libwebp_anim",
                                           "-lossless",
                                           "1",
                                           "-pix_fmt",
                                           "bgra",
                                           "-f",
                                           "webp",
                                           "pipe:1"});
        const auto alpha = native_alpha_encode({{"executable", absolute_ffmpeg_binary().string()},
                                                {"arguments", arguments},
                                                {"durationsMs", durations},
                                                {"width", width},
                                                {"height", height},
                                                {"outputPath", stage_alpha.generic_string()}});
        if (!alpha.value("ok", false))
            throw VideoError("Native animated WebP alpha preparation failed: " +
                             alpha.value("error", std::string("invalid runtime alpha")));
        encoded_alpha = alpha.value("hasAlpha", false);
        if (encoded_alpha && read(stage_alpha, 128ull * 1024 * 1024).empty())
            throw VideoError("Animated WebP alpha output is empty.");
    }
    if (cancelled && cancelled())
        throw VideoError("Video preparation was cancelled.");
    if (!authoring::source_revision_matches(read(input, 512ull * 1024 * 1024),
                                            revisions.at(relative).get<std::string>()))
        throw VideoError("Video source changed while preparing media.");
    const auto alpha_digest =
        encoded_alpha ? "sha256:" + digest(read(stage_alpha, 128ull * 1024 * 1024)) : std::string{};
    const auto existing_status = fs::symlink_status(destination);
    if (fs::exists(existing_status) &&
        (fs::is_symlink(existing_status) || !fs::is_directory(existing_status)))
        throw VideoError("Existing prepared media destination is not a safe directory.");
    const auto matches = [&](const fs::path& file, const std::string& expected) {
        std::error_code error;
        const auto status = fs::symlink_status(destination / file, error);
        return !error && fs::is_regular_file(status) && !fs::is_symlink(status) &&
               read(destination / file, 128ull * 1024 * 1024) == expected;
    };
    const bool reusable =
        fs::exists(existing_status) && matches("opaque.webm", browser_bytes) &&
        (!encoded_alpha || matches("alpha.webp", read(stage_alpha, 128ull * 1024 * 1024)));
    if (!reusable) {
        fs::remove(snapshot);
        fs::remove(stage / "ffmpeg.stdout");
        fs::remove(stage / "ffmpeg.stderr");
        // Do not overwrite potentially open media files. Quarantine a damaged
        // generated revision, then install a complete staged directory.
        fs::path displaced;
        if (fs::exists(existing_status)) {
            displaced = parent / (key + ".damaged-" + std::to_string(nonce));
            fs::rename(destination, displaced);
        }
        try {
            fs::rename(stage, destination);
        } catch (...) {
            if (!displaced.empty() && !fs::exists(destination)) {
                std::error_code ignored;
                fs::rename(displaced, destination, ignored);
            }
            throw;
        }
        if (!displaced.empty()) {
            std::error_code ignored;
            fs::remove_all(displaced, ignored);
        }
    }
    const auto package_path = "assets/.prepared-media/" +
                              segment(request.at("animationId").get<std::string>()) + "/" +
                              segment(request.at("motionId").get<std::string>()) + "/" +
                              key.substr(0, 16) + "/opaque.webm";
    artifact["fileEntries"].push_back(
        {{"source", (destination / "opaque.webm").generic_string()},
         {"packagePath", package_path},
         {"storage", "stored"},
         {"assetId", "prepared-media:" + request.at("animationId").get<std::string>() + ":" +
                         request.at("motionId").get<std::string>() + ":browser"},
         {"kind", "prepared-media"},
         {"expectedSha256", "sha256:" + digest(browser_bytes)}});
    artifact["packageOptions"]["fileEntries"].push_back(
        {{"source", (destination / "opaque.webm").generic_string()},
         {"packagePath", package_path},
         {"storage", "stored"},
         {"expectedSha256", "sha256:" + digest(browser_bytes)}});
    const auto append_warning = [&](std::string code, std::string message) {
        const auto path =
            "/animations/" + request.at("animationId").get<std::string>() + "/data/motions";
        artifact["diagnostics"].push_back(
            {{"code", std::move(code)},
             {"severity", "warning"},
             {"path", path},
             {"message", std::move(message)},
             {"category", "Animations"},
             {"boundaries", Json::array({"authoring", "runtime-package"})},
             {"ownerPaths",
              Json::array({"/animations/" + request.at("animationId").get<std::string>()})}});
    };
    if (color.reduced_precision)
        append_warning("animation.video.color-precision-reduced",
                       "Video motion '" + request.at("motionId").get<std::string>() +
                           "' uses HDR or high-bit-depth color. Runtime preparation converts it to "
                           "SDR/8-bit BT.709.");
    if (probe.stderr_text.find(" Audio:") != std::string::npos)
        append_warning("animation.video.audio-ignored",
                       "Video motion '" + request.at("motionId").get<std::string>() +
                           "' contains audio. Generic Animation is visual-only; embedded audio is "
                           "ignored and removed from the prepared runtime representation.");
    Json result{{"animationId", request.at("animationId")},
                {"motionId", request.at("motionId")},
                {"representation", "opaque-vp9-webm"},
                {"contentHash", key},
                {"browserVideo", {{"path", package_path}, {"width", width}, {"height", height}}},
                {"frames", std::move(frames)}};
    if (encoded_alpha) {
        const auto alpha_path = package_path.substr(0, package_path.size() - 11) + "alpha.webp";
        result["alphaWebp"] = {{"path", alpha_path}};
        artifact["fileEntries"].push_back(
            {{"source", (destination / "alpha.webp").generic_string()},
             {"packagePath", alpha_path},
             {"storage", "stored"},
             {"assetId", "prepared-media:" + request.at("animationId").get<std::string>() + ":" +
                             request.at("motionId").get<std::string>() + ":alpha"},
             {"kind", "prepared-media"},
             {"expectedSha256", alpha_digest}});
        artifact["packageOptions"]["fileEntries"].push_back(
            {{"source", (destination / "alpha.webp").generic_string()},
             {"packagePath", alpha_path},
             {"storage", "stored"},
             {"expectedSha256", alpha_digest}});
    }
    return result;
}

} // namespace

void prepare_native_runtime_media(Json& artifact, const Json& project, const Json& revisions,
                                  const fs::path& root, const std::function<bool()>& cancelled)
{
    Json manifest{
        {"schema", "noveltea.private.prepared-media"}, {"version", 1}, {"motions", Json::array()}};
    const auto animations = project.value("animations", Json::object());
    for (const auto& [id, record] : animations.items()) {
        const auto& data = record.at("data");
        for (const auto& motion : data.at("motions")) {
            if (motion.value("kind", "") != "video")
                continue;
            const auto asset_id = motion.at("video").at("$ref").at("id").get<std::string>();
            const auto& asset = project.at("assets").at(asset_id).at("data");
            if (asset.value("kind", "") != "video")
                throw VideoError("Animation video motion must reference a Video Asset.");
            Json request{{"animationId", id},
                         {"motionId", motion.at("id")},
                         {"assetId", asset_id},
                         {"sourcePath", asset.at("source").at("path")},
                         {"canvas", data.at("canvas")}};
            for (const auto* optional : {"sourceRange", "frameSampling"})
                if (motion.contains(optional))
                    request[optional] = motion.at(optional);
            try {
                manifest["motions"].push_back(
                    prepare_video(request, revisions, root, artifact, cancelled));
            } catch (const std::exception& error) {
                throw VideoError("Cannot prepare Animation '" + id + "' motion '" +
                                 motion.at("id").get<std::string>() + "': " + error.what());
            }
        }
    }
    if (!manifest["motions"].empty()) {
        artifact["packageOptions"]["textEntries"].push_back(
            {{"text", manifest.dump()},
             {"packagePath", "assets/.prepared-media/manifest.json"},
             {"storage", "compressed"}});
        const auto media_files =
            std::count_if(artifact.at("fileEntries").begin(), artifact.at("fileEntries").end(),
                          [](const Json& item) { return item.at("kind") == "prepared-media"; });
        artifact["manifestPreview"]["entryCount"] =
            artifact["manifestPreview"]["entryCount"].get<std::size_t>() + media_files + 1;
        artifact["manifestPreview"]["assetCount"] = artifact["fileEntries"].size();
    }
}

} // namespace noveltea::cli
