noveltea_inventory = noveltea_inventory or {}

function noveltea_inventory.dismiss(event, element, document)
    local mount = Game.mount_context()
    return mount ~= nil and mount:dismiss()
end
