#include "media/native_video_hardware.hpp"

#ifdef __ANDROID__
#include <SDL3/SDL_system.h>
#include <jni.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>
#include <algorithm>
#include <cstring>
#include <string>

namespace noveltea::media {
namespace {
std::string hardware_codec_name()
{
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    if (!env)
        return {};
    if (env->PushLocalFrame(32) < 0) {
        env->ExceptionClear();
        return {};
    }
    std::string selected;
    const auto clear = [&] {
        if (!env->ExceptionCheck())
            return true;
        env->ExceptionClear();
        return false;
    };
    const auto find_class = [&](const char* name) {
        auto result = env->FindClass(name);
        return clear() ? result : nullptr;
    };
    const auto method = [&](jclass type, const char* name, const char* signature) {
        auto result = env->GetMethodID(type, name, signature);
        return clear() ? result : nullptr;
    };
    auto list_class = find_class("android/media/MediaCodecList");
    auto info_class = find_class("android/media/MediaCodecInfo");
    if (clear() && list_class && info_class) {
        auto constructor = method(list_class, "<init>", "(I)V");
        auto list_method = method(list_class, "getCodecInfos", "()[Landroid/media/MediaCodecInfo;");
        auto encoder_method = method(info_class, "isEncoder", "()Z");
        auto name_method = method(info_class, "getName", "()Ljava/lang/String;");
        auto types_method = method(info_class, "getSupportedTypes", "()[Ljava/lang/String;");
        if (clear() && constructor && list_method && encoder_method && name_method &&
            types_method) {
            auto hardware_method = method(info_class, "isHardwareAccelerated", "()Z");
            auto list = env->NewObject(list_class, constructor, 1);
            if (!clear())
                list = nullptr;
            auto infos = list ? static_cast<jobjectArray>(env->CallObjectMethod(list, list_method))
                              : nullptr;
            if (clear() && infos) {
                const auto count = env->GetArrayLength(infos);
                for (jsize i = 0; i < count && selected.empty(); ++i) {
                    auto info = env->GetObjectArrayElement(infos, i);
                    if (!clear() || !info || env->CallBooleanMethod(info, encoder_method) ||
                        !clear() ||
                        (hardware_method &&
                         (!env->CallBooleanMethod(info, hardware_method) || !clear()))) {
                        (void)clear();
                        if (info)
                            env->DeleteLocalRef(info);
                        continue;
                    }
                    auto name = static_cast<jstring>(env->CallObjectMethod(info, name_method));
                    if (!clear()) {
                        env->DeleteLocalRef(info);
                        continue;
                    }
                    const auto* text = name ? env->GetStringUTFChars(name, nullptr) : nullptr;
                    const bool readable_name = clear();
                    std::string candidate = text ? text : "";
                    if (text)
                        env->ReleaseStringUTFChars(name, text);
                    auto types =
                        readable_name
                            ? static_cast<jobjectArray>(env->CallObjectMethod(info, types_method))
                            : nullptr;
                    if (clear() && types && !candidate.starts_with("OMX.google.") &&
                        !candidate.starts_with("c2.android.") &&
                        !candidate.starts_with("c2.google.")) {
                        for (jsize j = 0; j < env->GetArrayLength(types); ++j) {
                            auto type = static_cast<jstring>(env->GetObjectArrayElement(types, j));
                            if (!clear())
                                break;
                            const auto* mime =
                                type ? env->GetStringUTFChars(type, nullptr) : nullptr;
                            if (!clear()) {
                                if (type)
                                    env->DeleteLocalRef(type);
                                break;
                            }
                            if (mime && std::strcmp(mime, "video/x-vnd.on2.vp9") == 0)
                                selected = candidate;
                            if (mime)
                                env->ReleaseStringUTFChars(type, mime);
                            if (type)
                                env->DeleteLocalRef(type);
                        }
                    }
                    if (types)
                        env->DeleteLocalRef(types);
                    if (name)
                        env->DeleteLocalRef(name);
                    env->DeleteLocalRef(info);
                }
            }
        }
    }
    if (!clear())
        selected.clear();
    env->PopLocalFrame(nullptr);
    return selected;
}

class MediaCodecDecoder final : public NativeVideoHardwareDecoder {
public:
    explicit MediaCodecDecoder(std::shared_ptr<const NativeVideoSource> source)
        : m_source(std::move(source))
    {
    }
    ~MediaCodecDecoder() override
    {
        if (m_codec) {
            if (m_started)
                (void)AMediaCodec_stop(m_codec);
            AMediaCodec_delete(m_codec);
        }
    }
    bool open()
    {
        const auto name = hardware_codec_name();
        if (name.empty())
            return false;
        m_codec = AMediaCodec_createCodecByName(name.c_str());
        auto* format = AMediaFormat_new();
        if (!m_codec || !format) {
            if (format)
                AMediaFormat_delete(format);
            return false;
        }
        AMediaFormat_setString(format, AMEDIAFORMAT_KEY_MIME, "video/x-vnd.on2.vp9");
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_WIDTH, m_source->width());
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_HEIGHT, m_source->height());
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_COLOR_FORMAT, 21);
        const auto max_packet =
            std::max_element(m_source->packets().begin(), m_source->packets().end(),
                             [](const auto& a, const auto& b) { return a.size < b.size; })
                ->size;
        AMediaFormat_setInt32(format, AMEDIAFORMAT_KEY_MAX_INPUT_SIZE,
                              static_cast<std::int32_t>(max_packet));
        const auto configured = AMediaCodec_configure(m_codec, format, nullptr, nullptr, 0);
        AMediaFormat_delete(format);
        if (configured != AMEDIA_OK || AMediaCodec_start(m_codec) != AMEDIA_OK)
            return false;
        m_started = true;
        const auto first = m_source->packet(0);
        m_full_range = first.size() > 4 && (first[4] & 0x10) != 0;
        m_bt709 = first.size() > 4 && (first[4] >> 5) == 2;
        return true;
    }
    const char* backend() const noexcept override { return "mediacodec-vp9"; }
    core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    decode(std::size_t index) override
    {
        using Frame = std::shared_ptr<const NativeVideoFrame>;
        const auto fail = [] {
            return core::Result<Frame, core::Diagnostics>::failure(
                {{.code = "assets.native_video.hardware_failed",
                  .message = "MediaCodec VP9 sample realization failed."}});
        };
        const auto input = AMediaCodec_dequeueInputBuffer(m_codec, 500000);
        if (input < 0)
            return fail();
        std::size_t capacity = 0;
        auto* buffer = AMediaCodec_getInputBuffer(m_codec, input, &capacity);
        const auto packet = m_source->packet(index);
        if (!buffer || packet.size() > capacity)
            return fail();
        std::memcpy(buffer, packet.data(), packet.size());
        const auto time = m_source->packets()[index].time_ns;
        if (AMediaCodec_queueInputBuffer(m_codec, input, 0, packet.size(), time / 1000, 0) !=
            AMEDIA_OK)
            return fail();
        for (unsigned attempt = 0; attempt < 4; ++attempt) {
            AMediaCodecBufferInfo info{};
            const auto output = AMediaCodec_dequeueOutputBuffer(m_codec, &info, 500000);
            if (output == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED ||
                output == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED)
                continue;
            if (output < 0)
                return fail();
            auto* format = AMediaCodec_getOutputFormat(m_codec);
            std::int32_t color = 0, stride = m_source->width(), slice_height = m_source->height(),
                         crop_left = 0, crop_top = 0;
            const bool valid =
                format && AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_COLOR_FORMAT, &color);
            if (format) {
                (void)AMediaFormat_getInt32(format, "stride", &stride);
                (void)AMediaFormat_getInt32(format, "slice-height", &slice_height);
                (void)AMediaFormat_getInt32(format, "crop-left", &crop_left);
                (void)AMediaFormat_getInt32(format, "crop-top", &crop_top);
                AMediaFormat_delete(format);
            }
            auto* data = AMediaCodec_getOutputBuffer(m_codec, output, &capacity);
            const auto release = [&] {
                (void)AMediaCodec_releaseOutputBuffer(m_codec, output, false);
            };
            if (!valid || !data || info.offset < 0 || info.size < 0 ||
                info.presentationTimeUs != static_cast<std::int64_t>(time / 1000) ||
                stride < m_source->width() || stride > 16384 || slice_height < m_source->height() ||
                slice_height > 8192 || crop_left || crop_top ||
                (color != 19 && color != 21 && color != 0x7fa30c00) ||
                static_cast<std::size_t>(info.offset) > capacity ||
                static_cast<std::size_t>(info.size) > capacity - info.offset) {
                release();
                return fail();
            }
            data += info.offset;
            const auto cw = (m_source->width() + 1u) / 2, ch = (m_source->height() + 1u) / 2;
            const auto y_size = static_cast<std::size_t>(stride) * slice_height;
            const auto chroma_stride =
                color == 19 ? (stride + 1u) / 2 : static_cast<unsigned>(stride);
            const auto uv_size =
                static_cast<std::size_t>(chroma_stride) * ((slice_height + 1u) / 2);
            if (y_size + uv_size * (color == 19 ? 2 : 1) > static_cast<std::size_t>(info.size) ||
                chroma_stride < cw * (color == 19 ? 1 : 2)) {
                release();
                return fail();
            }
            auto frame = std::make_shared<NativeVideoFrame>();
            frame->time_ns = time;
            frame->width = m_source->width();
            frame->height = m_source->height();
            frame->full_range = m_full_range;
            frame->bt709 = m_bt709;
            frame->y.resize(static_cast<std::size_t>(frame->width) * frame->height);
            frame->u.resize(cw * ch);
            frame->v.resize(cw * ch);
            for (unsigned row = 0; row < frame->height; ++row)
                std::memcpy(frame->y.data() + row * frame->width, data + row * stride,
                            frame->width);
            for (unsigned row = 0; row < ch; ++row)
                for (unsigned column = 0; column < cw; ++column) {
                    frame->u[row * cw + column] =
                        data[y_size + row * chroma_stride + column * (color == 19 ? 1 : 2)];
                    frame->v[row * cw + column] =
                        data[y_size + (color == 19 ? uv_size : 1) + row * chroma_stride +
                             column * (color == 19 ? 1 : 2)];
                }
            release();
            return core::Result<Frame, core::Diagnostics>::success(std::move(frame));
        }
        return fail();
    }

private:
    std::shared_ptr<const NativeVideoSource> m_source;
    AMediaCodec* m_codec = nullptr;
    bool m_started = false;
    bool m_full_range = false;
    bool m_bt709 = false;
};
} // namespace
std::unique_ptr<NativeVideoHardwareDecoder>
try_mediacodec_video(std::shared_ptr<const NativeVideoSource> source)
{
    auto decoder = std::make_unique<MediaCodecDecoder>(std::move(source));
    return decoder->open() ? std::move(decoder) : nullptr;
}
} // namespace noveltea::media
#endif
