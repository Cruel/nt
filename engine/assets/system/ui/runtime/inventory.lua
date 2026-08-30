noveltea_inventory = noveltea_inventory or {}

function noveltea_inventory.dismiss(event, element, document)
    local mount = Game.mount_context()
    return mount ~= nil and mount:dismiss()
end

function noveltea_inventory.activate(event, element, document)
    local subject_id = element:GetAttribute("data-subject-id")
    if subject_id == nil or subject_id == "" then
        return false
    end
    if not Game.ui.primary_activate("interactable", subject_id) then
        return false
    end
    local mount = Game.mount_context()
    if mount ~= nil then
        mount:dismiss()
    end
    return true
end
