#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <string_view>

namespace noveltea {

struct MaterialContractInterfaceSlot {
    std::string_view name;
    std::string_view physical_type;
    std::string_view semantic;
};

struct MaterialContractPolicyValues {
    std::array<std::string_view, 3> values{};
    std::uint8_t count = 0;
};

struct MaterialContractSamplerSlot {
    std::string_view name;
    std::string_view semantic;
    std::string_view physical_type;
    std::uint8_t stage = 0;
    std::string_view source_ownership;
    MaterialContractPolicyValues address_policy;
    MaterialContractPolicyValues filter_policy;
    std::string_view observation;
};

struct MaterialContractStandardSemantic {
    std::string_view semantic;
    std::string_view logical_type;
};

struct MaterialContractPipelineState {
    std::string_view blend;
    std::string_view output_alpha;
};

struct MaterialRoleContract {
    std::string_view id;
    std::span<const MaterialContractInterfaceSlot> attributes;
    std::span<const MaterialContractInterfaceSlot> varyings;
    std::span<const MaterialContractInterfaceSlot> predefined_uniforms;
    std::span<const MaterialContractInterfaceSlot> renderer_uniforms;
    std::span<const MaterialContractSamplerSlot> samplers;
    std::span<const MaterialContractStandardSemantic> standard_semantics;
    MaterialContractPipelineState pipeline_state;
};

struct MaterialContractCapability {
    std::string_view slot;
    std::string_view state;
};

struct MaterialContractPreviewFixture {
    std::string_view fixture;
    std::string_view geometry;
    std::string_view background;
};

struct MaterialPresetContract {
    std::string_view id;
    std::string_view label;
    std::string_view role;
    std::string_view contract_identity;
    std::string_view contract_fingerprint;
    std::string_view vertex_source;
    std::string_view fragment_source;
    std::string_view varying_definition;
    std::string_view program_name;
    std::span<const MaterialContractCapability> sampler_capabilities;
    std::string_view default_parameters_json;
    MaterialContractPreviewFixture preview;
};

[[nodiscard]] std::span<const MaterialRoleContract> material_role_contracts() noexcept;
[[nodiscard]] std::span<const MaterialPresetContract> material_preset_contracts() noexcept;
[[nodiscard]] const MaterialRoleContract* material_role_contract(std::string_view id) noexcept;
[[nodiscard]] const MaterialPresetContract* material_preset_contract(std::string_view id) noexcept;
[[nodiscard]] std::string_view material_contract_fingerprint_algorithm() noexcept;
[[nodiscard]] std::string_view material_contract_fingerprint_encoding() noexcept;

} // namespace noveltea
