#include "media/native_video_hardware.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0a00
#endif
#include <windows.h>
#include <d3d11.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <SDL3/SDL_timer.h>
#include <cstring>

namespace noveltea::media {
namespace {
template<class T> class Com {
public:
    ~Com() { reset(); }
    void reset()
    {
        if (p)
            p->Release();
        p = nullptr;
    }
    T** put()
    {
        reset();
        return &p;
    }
    T* get() const { return p; }
    T* operator->() const { return p; }
    explicit operator bool() const { return p != nullptr; }
    T* p = nullptr;
};
class Apartment {
public:
    Apartment() : status(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~Apartment()
    {
        if (SUCCEEDED(status))
            CoUninitialize();
    }
    HRESULT status;
};

class MediaFoundationDecoder final : public NativeVideoHardwareDecoder {
public:
    explicit MediaFoundationDecoder(std::shared_ptr<const NativeVideoSource> source)
        : m_source(std::move(source))
    {
    }
    ~MediaFoundationDecoder() override
    {
        m_events.reset();
        m_transform.reset();
        if (m_activation)
            (void)m_activation->ShutdownObject();
        m_activation.reset();
        if (m_started)
            (void)MFShutdown();
    }
    bool open()
    {
        Apartment apartment;
        if (FAILED(apartment.status) || FAILED(MFStartup(MF_VERSION, MFSTARTUP_LITE)))
            return false;
        m_started = true;
        if (FAILED(D3D11CreateDevice(
                nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                D3D11_SDK_VERSION, m_device.put(), nullptr, m_context.put())))
            return false;
        UINT token = 0;
        if (FAILED(MFCreateDXGIDeviceManager(&token, m_manager.put())) ||
            FAILED(m_manager->ResetDevice(m_device.get(), token)))
            return false;
        MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_VP90};
        MFT_REGISTER_TYPE_INFO output{MFMediaType_Video, MFVideoFormat_NV12};
        IMFActivate** activations = nullptr;
        UINT count = 0;
        const auto enumeration = MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER,
                                           MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                                           &input, &output, &activations, &count);
        if (FAILED(enumeration))
            return false;
        for (UINT index = 0; index < count; ++index) {
            if (!m_transform &&
                SUCCEEDED(activations[index]->ActivateObject(IID_PPV_ARGS(m_transform.put())))) {
                m_activation.p = activations[index];
                m_activation->AddRef();
            }
            activations[index]->Release();
        }
        CoTaskMemFree(activations);
        if (!m_transform)
            return false;
        Com<IMFAttributes> attributes;
        UINT32 asynchronous = 0, aware = 0;
        if (FAILED(m_transform->GetAttributes(attributes.put())) ||
            FAILED(attributes->GetUINT32(MF_SA_D3D11_AWARE, &aware)) || !aware ||
            FAILED(m_transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER,
                                               reinterpret_cast<ULONG_PTR>(m_manager.get()))))
            return false;
        (void)attributes->GetUINT32(MF_TRANSFORM_ASYNC, &asynchronous);
        m_async = asynchronous != 0;
        if (m_async && (FAILED(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE)) ||
                        FAILED(m_transform->QueryInterface(IID_PPV_ARGS(m_events.put())))))
            return false;
        const auto ids = m_transform->GetStreamIDs(1, &m_input, 1, &m_output);
        if (FAILED(ids) && ids != E_NOTIMPL)
            return false;
        Com<IMFMediaType> type;
        if (FAILED(MFCreateMediaType(type.put())) ||
            FAILED(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video)) ||
            FAILED(type->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_VP90)) ||
            FAILED(MFSetAttributeSize(type.get(), MF_MT_FRAME_SIZE, m_source->width(),
                                      m_source->height())) ||
            FAILED(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive)) ||
            FAILED(m_transform->SetInputType(m_input, type.get(), 0)) || !configure_output())
            return false;
        const auto first = m_source->packet(0);
        m_full_range = first.size() > 4 && (first[4] & 0x10) != 0;
        m_bt709 = first.size() > 4 && (first[4] >> 5) == 2;
        return SUCCEEDED(m_transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)) &&
               SUCCEEDED(m_transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0));
    }
    const char* backend() const noexcept override { return "mediafoundation-vp9"; }
    core::Result<std::shared_ptr<const NativeVideoFrame>, core::Diagnostics>
    decode(std::size_t index) override
    {
        using Frame = std::shared_ptr<const NativeVideoFrame>;
        const auto fail = [] {
            return core::Result<Frame, core::Diagnostics>::failure(
                {{.code = "assets.native_video.hardware_failed",
                  .message = "Media Foundation VP9 sample realization failed."}});
        };
        Apartment apartment;
        if (FAILED(apartment.status) || (m_async && !event(METransformNeedInput)))
            return fail();
        const auto packet = m_source->packet(index);
        Com<IMFMediaBuffer> encoded;
        Com<IMFSample> input;
        BYTE* data = nullptr;
        if (FAILED(MFCreateMemoryBuffer(static_cast<DWORD>(packet.size()), encoded.put())) ||
            FAILED(encoded->Lock(&data, nullptr, nullptr)))
            return fail();
        std::memcpy(data, packet.data(), packet.size());
        const auto unlocked = encoded->Unlock();
        const auto time = m_source->packets()[index].time_ns;
        if (FAILED(unlocked) ||
            FAILED(encoded->SetCurrentLength(static_cast<DWORD>(packet.size()))) ||
            FAILED(MFCreateSample(input.put())) || FAILED(input->AddBuffer(encoded.get())) ||
            FAILED(input->SetSampleTime(time / 100)) ||
            FAILED(m_transform->ProcessInput(m_input, input.get(), 0)))
            return fail();
        bool wait_for_output = m_async;
        for (unsigned attempt = 0; attempt < 4; ++attempt) {
            if (wait_for_output && !event(METransformHaveOutput))
                return fail();
            MFT_OUTPUT_STREAM_INFO info{};
            if (FAILED(m_transform->GetOutputStreamInfo(m_output, &info)))
                return fail();
            Com<IMFSample> sample;
            Com<IMFMediaBuffer> buffer;
            if (!(info.dwFlags &
                  (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES))) {
                const auto limit =
                    static_cast<std::uint64_t>(m_source->width()) * m_source->height() * 4 +
                    1024 * 1024;
                if (info.cbSize > limit || FAILED(MFCreateSample(sample.put())) ||
                    FAILED(MFCreateMemoryBuffer(info.cbSize, buffer.put())) ||
                    FAILED(sample->AddBuffer(buffer.get())))
                    return fail();
            }
            MFT_OUTPUT_DATA_BUFFER output{m_output, sample.get(), 0, nullptr};
            DWORD status = 0;
            const auto realized = m_transform->ProcessOutput(0, 1, &output, &status);
            if (output.pEvents)
                output.pEvents->Release();
            if (!sample)
                sample.p = output.pSample;
            if (realized == MF_E_TRANSFORM_STREAM_CHANGE) {
                if (!configure_output())
                    return fail();
                wait_for_output = false;
                continue;
            }
            LONGLONG presented = -1;
            if (FAILED(realized) || !sample || FAILED(sample->GetSampleTime(&presented)) ||
                presented != static_cast<LONGLONG>(time / 100) ||
                FAILED(sample->GetBufferByIndex(0, buffer.put())))
                return fail();
            Com<IMFDXGIBuffer> dxgi;
            Com<ID3D11Texture2D> texture;
            UINT subresource = 0;
            if (FAILED(buffer->QueryInterface(IID_PPV_ARGS(dxgi.put()))) ||
                FAILED(dxgi->GetResource(IID_PPV_ARGS(texture.put()))) ||
                FAILED(dxgi->GetSubresourceIndex(&subresource)))
                return fail();
            D3D11_TEXTURE2D_DESC description{};
            texture->GetDesc(&description);
            if (description.Format != DXGI_FORMAT_NV12 || description.Width < m_source->width() ||
                description.Height < m_source->height() || description.Width > 8192 ||
                description.Height > 8192)
                return fail();
            if (m_staging) {
                D3D11_TEXTURE2D_DESC current{};
                m_staging->GetDesc(&current);
                if (current.Width != description.Width || current.Height != description.Height)
                    m_staging.reset();
            }
            if (!m_staging) {
                description.MipLevels = 1;
                description.ArraySize = 1;
                description.Usage = D3D11_USAGE_STAGING;
                description.BindFlags = 0;
                description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
                description.MiscFlags = 0;
                if (FAILED(m_device->CreateTexture2D(&description, nullptr, m_staging.put())))
                    return fail();
            }
            m_context->CopySubresourceRegion(m_staging.get(), 0, 0, 0, 0, texture.get(),
                                             subresource, nullptr);
            D3D11_MAPPED_SUBRESOURCE mapped{};
            if (FAILED(m_context->Map(m_staging.get(), 0, D3D11_MAP_READ, 0, &mapped)))
                return fail();
            const auto unmap = [&] { m_context->Unmap(m_staging.get(), 0); };
            if (!mapped.pData || mapped.RowPitch < m_source->width()) {
                unmap();
                return fail();
            }
            auto frame = std::make_shared<NativeVideoFrame>();
            frame->width = m_source->width();
            frame->height = m_source->height();
            frame->time_ns = time;
            frame->full_range = m_full_range;
            frame->bt709 = m_bt709;
            const auto cw = (frame->width + 1u) / 2, ch = (frame->height + 1u) / 2;
            if (mapped.RowPitch < cw * 2) {
                unmap();
                return fail();
            }
            frame->y.resize(static_cast<std::size_t>(frame->width) * frame->height);
            frame->u.resize(cw * ch);
            frame->v.resize(cw * ch);
            const auto* y = static_cast<const std::uint8_t*>(mapped.pData);
            const auto* uv = y + static_cast<std::size_t>(mapped.RowPitch) * description.Height;
            for (unsigned row = 0; row < frame->height; ++row)
                std::memcpy(frame->y.data() + row * frame->width, y + row * mapped.RowPitch,
                            frame->width);
            for (unsigned row = 0; row < ch; ++row)
                for (unsigned column = 0; column < cw; ++column) {
                    frame->u[row * cw + column] = uv[row * mapped.RowPitch + column * 2];
                    frame->v[row * cw + column] = uv[row * mapped.RowPitch + column * 2 + 1];
                }
            unmap();
            return core::Result<Frame, core::Diagnostics>::success(std::move(frame));
        }
        return fail();
    }

private:
    bool configure_output()
    {
        for (DWORD index = 0; index < 64; ++index) {
            Com<IMFMediaType> type;
            if (FAILED(m_transform->GetOutputAvailableType(m_output, index, type.put())))
                return false;
            GUID subtype{};
            if (SUCCEEDED(type->GetGUID(MF_MT_SUBTYPE, &subtype)) &&
                subtype == MFVideoFormat_NV12 &&
                SUCCEEDED(m_transform->SetOutputType(m_output, type.get(), 0)))
                return true;
        }
        return false;
    }
    bool event(MediaEventType wanted)
    {
        auto& pending = wanted == METransformNeedInput ? m_need_input : m_have_output;
        if (pending) {
            --pending;
            return true;
        }
        const auto deadline = SDL_GetTicks() + 2000;
        while (SDL_GetTicks() < deadline) {
            Com<IMFMediaEvent> event;
            const auto received = m_events->GetEvent(MF_EVENT_FLAG_NO_WAIT, event.put());
            if (received == MF_E_NO_EVENTS_AVAILABLE) {
                SDL_Delay(1);
                continue;
            }
            MediaEventType type = MEUnknown;
            HRESULT status = E_FAIL;
            if (FAILED(received) || FAILED(event->GetType(&type)) ||
                FAILED(event->GetStatus(&status)) || FAILED(status))
                return false;
            if (type == METransformNeedInput)
                ++m_need_input;
            else if (type == METransformHaveOutput)
                ++m_have_output;
            if (m_need_input > 16 || m_have_output > 16)
                return false;
            if (pending) {
                --pending;
                return true;
            }
        }
        return false;
    }
    std::shared_ptr<const NativeVideoSource> m_source;
    Com<IMFActivate> m_activation;
    Com<IMFTransform> m_transform;
    Com<IMFMediaEventGenerator> m_events;
    Com<IMFDXGIDeviceManager> m_manager;
    Com<ID3D11Device> m_device;
    Com<ID3D11DeviceContext> m_context;
    Com<ID3D11Texture2D> m_staging;
    DWORD m_input = 0, m_output = 0;
    unsigned m_need_input = 0, m_have_output = 0;
    bool m_started = false, m_async = false, m_full_range = false, m_bt709 = false;
};
} // namespace
std::unique_ptr<NativeVideoHardwareDecoder>
try_mediafoundation_video(std::shared_ptr<const NativeVideoSource> source)
{
    auto decoder = std::make_unique<MediaFoundationDecoder>(std::move(source));
    return decoder->open() ? std::move(decoder) : nullptr;
}
} // namespace noveltea::media
#endif
