#include "noveltea/render/material_contract.hpp"

#include "material_contract_registry.generated.hpp"

#include <algorithm>

namespace noveltea {

std::span<const MaterialRoleContract> material_role_contracts() noexcept
{
    return generated_material_contracts::roles;
}

std::span<const MaterialPresetContract> material_preset_contracts() noexcept
{
    return generated_material_contracts::presets;
}

const MaterialRoleContract* material_role_contract(std::string_view id) noexcept
{
    const auto roles = material_role_contracts();
    const auto it = std::find_if(roles.begin(), roles.end(),
                                 [id](const MaterialRoleContract& role) { return role.id == id; });
    return it == roles.end() ? nullptr : &*it;
}

const MaterialPresetContract* material_preset_contract(std::string_view id) noexcept
{
    const auto presets = material_preset_contracts();
    const auto it = std::find_if(presets.begin(), presets.end(),
                                 [id](const MaterialPresetContract& preset) {
                                     return preset.id == id;
                                 });
    return it == presets.end() ? nullptr : &*it;
}

std::string_view material_contract_fingerprint_algorithm() noexcept
{
    return generated_material_contracts::fingerprint_algorithm;
}

std::string_view material_contract_fingerprint_encoding() noexcept
{
    return generated_material_contracts::fingerprint_encoding;
}

} // namespace noveltea
