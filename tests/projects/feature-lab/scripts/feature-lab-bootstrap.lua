local function route_startup()
  local context = Game.startup_context()
  if type(context) ~= 'table' then
    return
  end
  local lab = context.feature_lab
  if type(lab) ~= 'table' or lab.mode ~= 'scenario' then
    return
  end
  if type(lab.entry_id) ~= 'string' or type(lab.room_id) ~= 'string' then
    return
  end
  if lab.room_id ~= 'feature-lab-home' then
    noveltea.flow.replace_room(lab.room_id)
  end
end

return {
  route_startup = route_startup,
}
