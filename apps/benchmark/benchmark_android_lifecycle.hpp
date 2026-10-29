#pragma once

#if defined(__ANDROID__)

#include <SDL3/SDL_system.h>
#include <jni.h>

namespace noveltea::benchmark {

// The benchmark Activity owns the Android surface even when an Engine-owned
// scenario temporarily owns SDL/bgfx. Engine::tick may return true while
// suspended; benchmark trials must not count those skipped frames as samples.
[[nodiscard]] inline bool android_benchmark_foreground()
{
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    if (!env)
        return false;
    auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity)
        return false;
    auto klass = env->GetObjectClass(activity);
    const auto ready = klass ? env->GetMethodID(klass, "isBenchmarkLaunchReady", "()Z") : nullptr;
    if (env->ExceptionCheck())
        env->ExceptionClear();
    bool foreground = false;
    if (ready) {
        foreground = env->CallBooleanMethod(activity, ready) == JNI_TRUE;
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            foreground = false;
        }
    }
    if (klass)
        env->DeleteLocalRef(klass);
    env->DeleteLocalRef(activity);
    return foreground;
}

} // namespace noveltea::benchmark

#endif
