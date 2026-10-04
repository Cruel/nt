trigger_panel_ui = {}
function trigger_panel_ui.show(document)
  local mount = assert(Game.mount_context())
  local box = document:GetElementById('trigger-box')
  local trigger = mount:trigger()
  local hint = mount:position_hint()
  local anchor = mount:anchor(box.offset_width, box.offset_height, 'nearest', 'bottom', 'start', 8, 12)
  local position = anchor or Layout.clamp_to_viewport(box, 950, 470, 12)
  document.style.left = position.x .. 'px'
  document.style.top = position.y .. 'px'
  document:GetElementById('trigger-values').inner_rml = trigger and
    ('Snapshot available; hint ' .. tostring(hint.x) .. ', ' .. tostring(hint.y) .. '; anchored ' .. tostring(position.x) .. ', ' .. tostring(position.y)) or
    'No activation geometry: safe measured viewport fallback.'
end
