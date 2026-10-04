local ready_title
local M = {}

function M.on_ready()
  ready_title = assert(Game.prop('board-title'))
end

function M.title()
  return ready_title
end

function M.refresh()
  assert(Game.set_prop('board-hook', 'exact'))
  local context = Game.startup_context()
  local probe = type(context) == 'table' and context.restart_probe or nil
  if type(probe) == 'table' then
    assert(probe.enabled == true and probe.count == 7 and probe.ratio == 1.25)
    assert(probe.label == 'fresh' and probe.optional == Data.null)
    assert(type(probe.nested) == 'table' and probe.nested.value == 'preserved')
    assert(Game.prop('board-title') == 'No notices')
    noveltea.notify('Restart admitted nested typed context and began from fresh gameplay defaults.')
  end
  local first = assert(Data.load('notice-board-data'))
  first.notices[1].title = 'Local draft'
  first.slots[1] = 99
  local fresh = assert(Data.load('notice-board-data'))
  assert(fresh.slots[1] == Data.null and fresh.notices[1].optional == Data.null)
  assert(Game.set_prop('board-title', fresh.notices[1].title))
  assert(Game.set_prop('board-stock', fresh.notices[1].stock))
  noveltea.notify('On Game Ready rebuilt title: ' .. ready_title)
  for _, id in ipairs({'missing-board', 'pilot-room-backdrop', '../notice-board.json'}) do
    local value, err = Data.load(id)
    assert(value == nil and type(err) == 'string')
  end
  noveltea.notify('Unavailable, wrong-kind and path-like Data IDs were handled; the board remains usable.')
end

function M.calendar()
  local epoch = os.time()
  local local_date = os.date('%Y-%m-%d %H:%M:%S', epoch)
  local utc_date = os.date('!%Y-%m-%d %H:%M:%S', epoch)
  local difference = os.difftime(epoch, epoch - 60)
  noveltea.notify('Local ' .. local_date .. ' / UTC ' .. utc_date .. ' / difference ' .. tostring(difference) .. ' seconds. Wall time is external to gameplay.')
end

function M.prefix_before_enter()
  assert(Game.set_prop('board-hook', 'prefix'))
end

function M.catchall_before_enter()
  assert(Game.set_prop('board-hook', 'catchall'))
end

M.before_enter = M.refresh
return M
