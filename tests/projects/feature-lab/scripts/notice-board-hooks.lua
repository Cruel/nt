local M = {}

function M.prefix_before_enter()
  assert(Game.set_prop('board-hook', 'prefix'))
end

function M.catchall_before_enter()
  assert(Game.set_prop('board-hook', 'catchall'))
end

return M
