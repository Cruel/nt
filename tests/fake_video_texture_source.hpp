#pragma once

#include "noveltea/assets/typed_assets.hpp"

namespace noveltea::test {

class FakeVideoTextureSession final : public assets::VideoTextureSession {
public:
    explicit FakeVideoTextureSession(assets::TextureAssetLoader& loader)
        : m_loader(loader), m_identity(s_next_identity++)
    {
    }
    std::uint64_t identity() const noexcept override { return m_identity; }
    const char* backend() const noexcept override { return "fake-video"; }
    std::uint64_t uploads_on_owner() const noexcept override { return m_uploads; }
    void set_presented_texture_on_owner(std::uint16_t) noexcept override {}
    std::shared_ptr<assets::VideoTextureResidencyPin>
    retain_residency(const assets::AssetLease<assets::TextureAsset>&) override
    {
        return {};
    }
    std::unique_ptr<assets::AssetPreparationTask<assets::TextureAsset>>
    create_texture_preparation_task(assets::TextureAssetRequest request) override
    {
        ++m_uploads;
        return m_loader.create_texture_preparation_task(request);
    }

private:
    assets::TextureAssetLoader& m_loader;
    std::uint64_t m_identity;
    std::uint64_t m_uploads = 0;
    inline static std::uint64_t s_next_identity = 1;
};

class FakeVideoTextureSource final : public assets::VideoTextureSource {
public:
    explicit FakeVideoTextureSource(assets::TextureAssetLoader& loader) : m_loader(loader) {}
    std::shared_ptr<assets::VideoTextureSession> create_session() override
    {
        return std::make_shared<FakeVideoTextureSession>(m_loader);
    }

private:
    assets::TextureAssetLoader& m_loader;
};

} // namespace noveltea::test
