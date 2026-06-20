#pragma once

#include <cstddef>
#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace noveltea {

struct TweenDebugInfo {
    std::string owner_id;
    std::string channel;
    double duration_seconds = 0.0;
    bool paused = false;
    bool finished = false;
};

class TweenService {
public:
    using CompletionCallback = std::function<void()>;

    TweenService();
    ~TweenService();

    TweenService(const TweenService&) = delete;
    TweenService& operator=(const TweenService&) = delete;

    void tween_float(std::string owner_id, std::string channel, float& target, float from, float to,
                     double duration_seconds, CompletionCallback on_complete = {});

    void advance(double delta_seconds);
    void reset();
    void pause_owner(const std::string& owner_id);
    void resume_owner(const std::string& owner_id);
    void kill_owner(const std::string& owner_id);
    void kill_channel(const std::string& channel);

    [[nodiscard]] std::size_t active_count() const;
    [[nodiscard]] std::vector<TweenDebugInfo> debug_snapshot() const;

private:
    struct Entry;
    struct Impl;
    void prune_finished();

    std::vector<std::unique_ptr<Entry>> m_entries;
    std::unique_ptr<Impl> m_impl;
    bool m_advancing = false;
};

} // namespace noveltea
