menu_board_ui = {}
function menu_board_ui.probe(input, pause)
  local ok, err = noveltea.layouts.mount('policy-probe', 'input-policy-probe', {
    plane='menu-overlay', order=40, clock='unscaled-presentation', input=input,
    pause=pause and 'pause-while-visible' or 'continue', dismiss_on_escape=true,
    inputs={caption=input .. (pause and ' + pause' or '')}
  })
  if not ok then error(err) end
end
function menu_board_ui.activate()
  local count, _, err = Game.prop('control-activations')
  if err then error(err) end
  assert(Game.set_prop('control-activations', count + 1))
  noveltea.notify('Control activations: ' .. tostring(count + 1))
end
function menu_board_ui.scales()
  assert(noveltea.layouts.mount('scale-inherit', 'scale-inherit', {owner='current-room'}))
  assert(noveltea.layouts.mount('scale-ignore', 'scale-ignore', {owner='current-room'}))
end
