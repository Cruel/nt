noveltea_verb_menu = noveltea_verb_menu or {}

function noveltea_verb_menu.position(event, element, document)
    local panel = document:GetElementById("nt_verb_menu")
    local mount = Game.mount_context ~= nil and Game.mount_context("runtime_verb_menu") or nil
    if panel == nil or mount == nil then
        return false
    end

    local anchor = mount:anchor(panel.offset_width, panel.offset_height,
                                "nearest", "bottom", "start", 8, 8, 8, 0)
    if anchor == nil then
        return false
    end
    panel.style.left = tostring(anchor.x) .. "px"
    panel.style.top = tostring(anchor.y) .. "px"
    return true
end
