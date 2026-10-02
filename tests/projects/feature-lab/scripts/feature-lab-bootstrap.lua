local function checked(ok, err)
  if not ok then
    error(err)
  end
end

local function compose_world_lab(_, presentation)
  local enabled, _, err = Game.prop('world-composition-enabled')
  if err then
    error(err)
  end
  checked(presentation.set_character_visible('pilot-guide', enabled))
end

local function lifecycle_can_leave(context)
  return not (context.selected_exit and context.selected_exit.exit == 'reject-source')
end

local function lifecycle_before_leave()
  local marker, _, err = Game.prop('lifecycle-before-leave-marker')
  if err then error(err) end
  noveltea.notify('Hook before-leave observed program marker=' .. tostring(marker) .. '.')
end

local function lifecycle_after_leave()
  noveltea.notify('Hook after-leave ran after the declarative after-leave program.')
end

local function lifecycle_before_enter()
  local marker, _, err = Game.prop('lifecycle-before-enter-marker')
  if err then error(err) end
  noveltea.notify('Hook before-enter observed program marker=' .. tostring(marker) .. '.')
end

local function lifecycle_after_enter(context)
  local active = context.active_room_context or {}
  noveltea.notify('Hook after-enter context: cause=' .. tostring(active.entry_cause or context.entry_cause) .. ', sequence=' .. tostring(active.entry_sequence or '?'))
end

local function lifecycle_reject_leave()
  noveltea.notify('Source reject-leave hook ran after declarative rejection handling.')
end

local function lifecycle_reject_enter()
  noveltea.notify('Target reject-enter hook ran after declarative rejection handling.')
end

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
  compose_world_lab = compose_world_lab,
  lifecycle_can_leave = lifecycle_can_leave,
  lifecycle_before_leave = lifecycle_before_leave,
  lifecycle_after_leave = lifecycle_after_leave,
  lifecycle_before_enter = lifecycle_before_enter,
  lifecycle_after_enter = lifecycle_after_enter,
  lifecycle_reject_leave = lifecycle_reject_leave,
  lifecycle_reject_enter = lifecycle_reject_enter,
}
