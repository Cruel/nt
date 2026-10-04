local M = {}

function M.prefix_before_enter()
  assert(Game.set_prop('board-hook', 'prefix'))
end

return M
