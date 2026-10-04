cursor_board_ui = {}
function cursor_board_ui.upper()
  assert(noveltea.layouts.mount('upper-cursor', 'cursor-upper', {
    order=100, input='none', clock='unscaled-presentation'
  }))
end
function cursor_board_ui.visible(visible)
  assert(noveltea.layouts.mount('upper-cursor', 'cursor-upper', {
    order=100, input='none', clock='unscaled-presentation', visible=visible
  }))
end
function cursor_board_ui.toggle()
  local value, _, err = Game.prop('hotspot-alternate')
  if err then error(err) end
  assert(Game.set_prop('hotspot-alternate', not value))
  noveltea.notify('Custom center target: ' .. (value and 'owner' or 'other alpha subject'))
end
function cursor_board_ui.gameplay()
  assert(noveltea.flow.call_scene('cursor-gameplay'))
end
