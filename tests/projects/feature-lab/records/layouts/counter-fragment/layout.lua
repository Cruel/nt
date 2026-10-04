counter_fragment_ui = {}

function counter_fragment_ui.read()
  local data = assert(Data.load('notice-board-data'))
  noveltea.notify(data.notices[1].title)
end
