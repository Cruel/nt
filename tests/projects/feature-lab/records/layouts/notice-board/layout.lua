notice_board_ui = {}

function notice_board_ui.ready_state()
  noveltea.notify('Authoritative board title: ' .. tostring(Game.prop('board-title')))
end

function notice_board_ui.read()
  local draft = assert(Data.load('notice-board-data'))
  draft.notices[1].stock = 999
  local fresh = assert(Data.load('notice-board-data'))
  assert(fresh.slots[1] == Data.null and fresh.notices[1].optional == Data.null)
  assert(Game.set_prop('board-stock', fresh.notices[1].stock))
  noveltea.notify(fresh.notices[1].title .. ': ' .. tostring(fresh.notices[1].stock) .. ' notices; JSON null positions survived the fresh Layout load.')
end

function notice_board_ui.calendar()
  local epoch = os.time()
  noveltea.notify('Layout local ' .. os.date('%Y-%m-%d %H:%M:%S', epoch) .. ' / UTC ' .. os.date('!%Y-%m-%d %H:%M:%S', epoch) .. ' / difference ' .. tostring(os.difftime(epoch, epoch - 60)))
end

function notice_board_ui.restart_probe()
  local first = Game.startup_context()
  assert(type(first) == 'table' and type(first.feature_lab) == 'table')
  local original_entry = first.feature_lab.entry_id
  first.feature_lab.entry_id = 'mutated-copy'
  local fresh = Game.startup_context()
  assert(fresh.feature_lab.entry_id == original_entry)
  assert(Game.restart({
    feature_lab = {
      mode = 'scenario',
      scenario_id = 'script-and-data',
      entry_id = 'script-and-data',
      room_id = 'script-and-data'
    },
    restart_probe = {
      enabled = true,
      count = 7,
      ratio = 1.25,
      label = 'fresh',
      optional = Data.null,
      nested = {value = 'preserved'}
    }
  }, false))
end

function notice_board_ui.accept()
  assert(Game.mount_context():signal('accepted', {}))
end
