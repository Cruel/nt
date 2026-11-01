#pragma once

// Host-only physical source notifications shared by the broker and native authoring session.
// A failed/unsupported monitor never supplies a proof: callers must fully rescan.

#include <filesystem>
#include <algorithm>
#include <cstddef>
#include <cstring>
#include <functional>
#include <mutex>
#include <set>
#include <string>
#include <string_view>
#include <utility>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winioctl.h>
#include <array>
#include <map>
#include <vector>
#elif defined(__APPLE__)
#include <CoreServices/CoreServices.h>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#endif

namespace noveltea::authoring {

struct PlatformSourceChanges {
    bool reliable = false;
    std::set<std::string> paths;
    std::set<std::string> directories;
};

class PlatformSourceMonitor {
public:
    using EventCallback = std::function<void(std::string, bool)>;
    explicit PlatformSourceMonitor(const std::filesystem::path& root, EventCallback on_event = {})
        : root_(root), on_event_(std::move(on_event))
    {
#if defined(_WIN32)
        initialize_windows();
#elif defined(__APPLE__)
        initialize_macos();
#endif
    }

    ~PlatformSourceMonitor()
    {
#if defined(_WIN32)
        if (volume_ != INVALID_HANDLE_VALUE)
            CloseHandle(volume_);
#elif defined(__APPLE__)
        stopping_.store(true);
        if (run_loop_) {
            CFRunLoopStop(run_loop_);
            CFRunLoopWakeUp(run_loop_);
        }
        if (thread_.joinable())
            thread_.join();
        if (run_loop_)
            CFRelease(run_loop_);
#endif
    }

    PlatformSourceMonitor(const PlatformSourceMonitor&) = delete;
    PlatformSourceMonitor& operator=(const PlatformSourceMonitor&) = delete;

    // NTFS may record a write against a different name for an externally linked inode.
    // Do not admit an incremental proof if a tracked source has multiple hard links.
    void protect_source(std::string_view relative)
    {
#if defined(_WIN32)
        std::scoped_lock lock(mutex_);
        if (link_unsafe_ || volume_ == INVALID_HANDLE_VALUE)
            return;
        const auto path = root_ / std::filesystem::u8path(relative);
        const HANDLE handle =
            CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (handle == INVALID_HANDLE_VALUE) {
            const auto error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
                link_unsafe_ = true;
            return;
        }
        BY_HANDLE_FILE_INFORMATION info{};
        if (!GetFileInformationByHandle(handle, &info) || info.nNumberOfLinks != 1)
            link_unsafe_ = true;
        CloseHandle(handle);
#else
        (void)relative;
#endif
    }

    [[nodiscard]] PlatformSourceChanges fence()
    {
        PlatformSourceChanges changes;
#if defined(_WIN32)
        std::scoped_lock lock(mutex_);
        if (volume_ == INVALID_HANDLE_VALUE || link_unsafe_)
            return changes;
        USN_JOURNAL_DATA_V0 journal{};
        DWORD returned = 0;
        if (!DeviceIoControl(volume_, FSCTL_QUERY_USN_JOURNAL, nullptr, 0, &journal,
                             sizeof(journal), &returned, nullptr) ||
            journal.UsnJournalID != journal_id_ || cursor_ < journal.FirstUsn ||
            cursor_ < journal.LowestValidUsn || cursor_ > journal.NextUsn)
            return changes;
        const USN upper = journal.NextUsn;
        std::map<DWORDLONG, std::wstring> parent_paths;
        while (cursor_ < upper) {
            READ_USN_JOURNAL_DATA_V0 request{};
            request.StartUsn = cursor_;
            request.ReasonMask = 0xffffffff;
            request.ReturnOnlyOnClose = FALSE;
            request.UsnJournalID = journal_id_;
            alignas(USN_RECORD_V2) std::array<std::byte, 64 * 1024> buffer{};
            if (!DeviceIoControl(volume_, FSCTL_READ_USN_JOURNAL, &request, sizeof(request),
                                 buffer.data(), static_cast<DWORD>(buffer.size()), &returned,
                                 nullptr) ||
                returned < sizeof(USN))
                return {};
            USN next = 0;
            std::memcpy(&next, buffer.data(), sizeof(next));
            if (next <= cursor_)
                return {};
            std::size_t offset = sizeof(USN);
            while (offset < returned) {
                if (returned - offset < sizeof(USN_RECORD_COMMON_HEADER))
                    return {};
                const auto* header =
                    reinterpret_cast<const USN_RECORD_COMMON_HEADER*>(buffer.data() + offset);
                if (header->RecordLength < offsetof(USN_RECORD_V2, FileName) ||
                    header->RecordLength > returned - offset || header->MajorVersion != 2)
                    return {}; // Unsupported record versions must not silently lose edits.
                const auto* record = reinterpret_cast<const USN_RECORD_V2*>(header);
                if (record->FileReferenceNumber == root_id_)
                    return {}; // The Project root itself moved or changed.
                if ((record->Reason & USN_REASON_HARD_LINK_CHANGE) != 0)
                    return {}; // A newly created external hard link may bypass path watchers.
                if (record->FileNameOffset < offsetof(USN_RECORD_V2, FileName) ||
                    record->FileNameLength % sizeof(WCHAR) != 0 ||
                    static_cast<std::size_t>(record->FileNameOffset) + record->FileNameLength >
                        record->RecordLength)
                    return {};
                const auto parent_id = record->ParentFileReferenceNumber;
                auto parent = parent_paths.find(parent_id);
                if (parent == parent_paths.end()) {
                    FILE_ID_DESCRIPTOR descriptor{};
                    descriptor.dwSize = sizeof(descriptor);
                    descriptor.Type = FileIdType;
                    descriptor.FileId.QuadPart = static_cast<LONGLONG>(parent_id);
                    HANDLE directory =
                        OpenFileById(volume_, &descriptor, FILE_READ_ATTRIBUTES,
                                     FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                     nullptr, FILE_FLAG_BACKUP_SEMANTICS);
                    if (directory == INVALID_HANDLE_VALUE)
                        return {}; // Deleted/renamed parent: rediscover conservatively.
                    const DWORD size = GetFinalPathNameByHandleW(
                        directory, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
                    std::wstring name(size, L'\0');
                    const DWORD written =
                        size == 0
                            ? 0
                            : GetFinalPathNameByHandleW(directory, name.data(), size,
                                                        FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
                    CloseHandle(directory);
                    if (written == 0 || written >= size)
                        return {};
                    name.resize(written);
                    parent = parent_paths.emplace(parent_id, std::move(name)).first;
                }
                const auto& parent_name = parent->second;
                const bool root_parent =
                    CompareStringOrdinal(parent_name.c_str(), -1, root_name_.c_str(), -1, TRUE) ==
                    CSTR_EQUAL;
                const bool nested_parent =
                    parent_name.size() > root_name_.size() &&
                    parent_name[root_name_.size()] == L'\\' &&
                    CompareStringOrdinal(parent_name.data(), static_cast<int>(root_name_.size()),
                                         root_name_.data(), static_cast<int>(root_name_.size()),
                                         TRUE) == CSTR_EQUAL;
                if (root_parent || nested_parent) {
                    std::wstring relative =
                        root_parent ? L"" : parent_name.substr(root_name_.size() + 1) + L"/";
                    const auto* filename = reinterpret_cast<const WCHAR*>(
                        reinterpret_cast<const std::byte*>(record) + record->FileNameOffset);
                    relative.append(filename, record->FileNameLength / sizeof(WCHAR));
                    std::replace(relative.begin(), relative.end(), L'\\', L'/');
                    // Invalid UTF-16 must fail closed rather than dropping an event.
                    const int required = WideCharToMultiByte(
                        CP_UTF8, WC_ERR_INVALID_CHARS, relative.data(),
                        static_cast<int>(relative.size()), nullptr, 0, nullptr, nullptr);
                    if (required <= 0)
                        return {};
                    std::string utf8(static_cast<std::size_t>(required), '\0');
                    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, relative.data(),
                                            static_cast<int>(relative.size()), utf8.data(),
                                            required, nullptr, nullptr) != required)
                        return {};
                    changes.paths.insert(utf8);
                    if ((record->FileAttributes &
                         (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
                        (record->Reason &
                         (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME)) != 0)
                        changes.directories.insert(std::move(utf8));
                }
                offset += header->RecordLength;
            }
            cursor_ = next;
        }
        changes.reliable = true;
#elif defined(__APPLE__)
        if (!stream_ || !started_)
            return changes;
        FSEventStreamFlushSync(stream_);
        std::scoped_lock lock(mutex_);
        if (unknown_)
            return changes;
        changes.reliable = true;
        changes.paths.swap(paths_);
        changes.directories.swap(directories_);
#endif
        return changes;
    }

private:
#if defined(_WIN32)
    void initialize_windows()
    {
        std::array<wchar_t, MAX_PATH> mount{};
        std::array<wchar_t, MAX_PATH> volume_name{};
        if (!GetVolumePathNameW(root_.c_str(), mount.data(), static_cast<DWORD>(mount.size())) ||
            !GetVolumeNameForVolumeMountPointW(mount.data(), volume_name.data(),
                                               static_cast<DWORD>(volume_name.size())))
            return;
        std::wstring device(volume_name.data());
        if (device.empty() || device.back() != L'\\')
            return;
        device.pop_back();
        volume_ = CreateFileW(device.c_str(), GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                              OPEN_EXISTING, 0, nullptr);
        if (volume_ == INVALID_HANDLE_VALUE)
            return;
        HANDLE root_handle =
            CreateFileW(root_.c_str(), FILE_READ_ATTRIBUTES,
                        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
        if (root_handle == INVALID_HANDLE_VALUE)
            return;
        BY_HANDLE_FILE_INFORMATION info{};
        const bool identified = GetFileInformationByHandle(root_handle, &info) != 0;
        const DWORD size = GetFinalPathNameByHandleW(root_handle, nullptr, 0,
                                                     FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
        std::wstring name(size, L'\0');
        const DWORD written =
            size == 0 ? 0
                      : GetFinalPathNameByHandleW(root_handle, name.data(), size,
                                                  FILE_NAME_NORMALIZED | VOLUME_NAME_GUID);
        CloseHandle(root_handle);
        if (!identified || written == 0 || written >= size)
            return;
        name.resize(written);
        while (!name.empty() && name.back() == L'\\')
            name.pop_back();
        root_name_ = std::move(name);
        root_id_ = (static_cast<DWORDLONG>(info.nFileIndexHigh) << 32U) | info.nFileIndexLow;
        USN_JOURNAL_DATA_V0 journal{};
        DWORD returned = 0;
        if (!DeviceIoControl(volume_, FSCTL_QUERY_USN_JOURNAL, nullptr, 0, &journal,
                             sizeof(journal), &returned, nullptr))
            return;
        cursor_ = journal.NextUsn;
        journal_id_ = journal.UsnJournalID;
    }
    HANDLE volume_ = INVALID_HANDLE_VALUE;
    std::wstring root_name_;
    DWORDLONG root_id_ = 0;
    DWORDLONG journal_id_ = 0;
    USN cursor_ = 0;
    std::mutex mutex_;
    bool link_unsafe_ = false;
#elif defined(__APPLE__)
    static void callback(ConstFSEventStreamRef, void* context, size_t count, void* event_paths,
                         const FSEventStreamEventFlags flags[], const FSEventStreamEventId[])
    {
        auto* self = static_cast<PlatformSourceMonitor*>(context);
        const auto* paths = static_cast<const char* const*>(event_paths);
        std::unique_lock lock(self->mutex_);
        const auto prefix = self->root_.generic_string() + "/";
        for (size_t i = 0; i < count; ++i) {
            constexpr auto unsafe =
                kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped |
                kFSEventStreamEventFlagKernelDropped | kFSEventStreamEventFlagEventIdsWrapped |
                kFSEventStreamEventFlagRootChanged | kFSEventStreamEventFlagMount |
                kFSEventStreamEventFlagUnmount;
            if ((flags[i] & unsafe) != 0) {
                self->unknown_ = true;
                continue;
            }
            const std::string_view path(paths[i]);
            if (!path.starts_with(prefix)) {
                self->unknown_ = true;
                continue;
            }
            auto relative = std::string(path.substr(prefix.size()));
            self->paths_.insert(relative);
            const bool directory = (flags[i] & (kFSEventStreamEventFlagItemIsDir |
                                                kFSEventStreamEventFlagItemIsSymlink |
                                                kFSEventStreamEventFlagItemRenamed)) != 0;
            if (directory)
                self->directories_.insert(std::move(relative));
            if (self->on_event_) {
                lock.unlock();
                self->on_event_(std::string(path.substr(prefix.size())), directory);
                lock.lock();
            }
        }
    }

    void initialize_macos()
    {
        thread_ = std::thread([this] {
            auto name = root_.generic_string();
            const auto path =
                CFStringCreateWithCString(kCFAllocatorDefault, name.c_str(), kCFStringEncodingUTF8);
            if (!path) {
                {
                    std::scoped_lock lock(mutex_);
                    ready_ = true;
                }
                cv_.notify_all();
                return;
            }
            const void* entries[] = {path};
            const auto paths =
                CFArrayCreate(kCFAllocatorDefault, entries, 1, &kCFTypeArrayCallBacks);
            CFRelease(path);
            FSEventStreamContext context{};
            context.info = this;
            const auto stream = FSEventStreamCreate(
                kCFAllocatorDefault, callback, &context, paths, kFSEventStreamEventIdSinceNow, 0.01,
                kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer |
                    kFSEventStreamCreateFlagWatchRoot);
            CFRelease(paths);
            if (!stream) {
                {
                    std::scoped_lock lock(mutex_);
                    ready_ = true;
                }
                cv_.notify_all();
                return;
            }
            auto* loop = CFRunLoopGetCurrent();
            CFRetain(loop);
            FSEventStreamScheduleWithRunLoop(stream, loop, kCFRunLoopDefaultMode);
            const bool started = FSEventStreamStart(stream);
            {
                std::scoped_lock lock(mutex_);
                stream_ = stream;
                run_loop_ = loop;
                started_ = started;
                ready_ = true;
            }
            cv_.notify_all();
            // An owner can be destroyed immediately after start: a bounded run-loop iteration
            // avoids a stop-before-run race that would otherwise hang the destructor.
            while (started && !stopping_.load())
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, true);
            FSEventStreamStop(stream);
            FSEventStreamInvalidate(stream);
            FSEventStreamRelease(stream);
        });
        std::unique_lock lock(mutex_);
        cv_.wait(lock, [this] { return ready_; });
    }
    std::mutex mutex_;
    std::condition_variable cv_;
    std::thread thread_;
    FSEventStreamRef stream_ = nullptr;
    CFRunLoopRef run_loop_ = nullptr;
    bool started_ = false;
    bool ready_ = false;
    std::atomic<bool> stopping_{false};
    bool unknown_ = false;
    std::set<std::string> paths_;
    std::set<std::string> directories_;
#endif
    std::filesystem::path root_;
    EventCallback on_event_;
};

} // namespace noveltea::authoring
