layout_counter_ui = layout_counter_ui or {}

local function checked(ok, err)
  if not ok then error(err) end
end

local function options(scope)
  return {
    owner = scope == 'visit' and 'current-room' or scope,
    room = scope == 'room' and 'layout-counter' or nil,
    clock = 'unscaled-presentation',
    inputs = {
      scope = scope,
      caption = scope .. ' panel',
      stock = { variable = 'panel-stock' },
      owner_label = { property = 'panel-label', target = { kind = 'room', id = 'layout-counter' } },
      mode = { facet = 'runtime-mode' },
      current_room = { facet = 'current-room' },
      paused = { facet = 'gameplay-paused' }
    },
    signals = { 'accepted' }
  }
end

function layout_counter_ui.open_panels()
  for _, scope in ipairs({ 'visit', 'room', 'session' }) do
    checked(noveltea.layouts.mount(scope .. '-panel', scope .. '-counter', options(scope)))
  end
end

function layout_counter_ui.read(document)
  local mount = assert(Game.mount_context())
  local scope = mount:input('scope')
  local state = assert(mount:state(scope))
  document:GetElementById('counter-caption').inner_rml = mount:input('caption')
  document:GetElementById('counter-values').inner_rml =
    'Slot count: ' .. tostring(state.count) .. '; label: ' .. state.details.label ..
    '; null member: ' .. tostring(state.details.optional == mount.null) ..
    '; null array slot: ' .. tostring(state.samples[2] == mount.null) ..
    '<br/>Stock: ' .. tostring(mount:input('stock')) ..
    '; owner: ' .. tostring(mount:input('owner_label')) ..
    '<br/>Mode: ' .. tostring(mount:input('mode')) ..
    '; Room: ' .. tostring(mount:input('current_room')) ..
    '; paused: ' .. tostring(mount:input('paused'))
end

function layout_counter_ui.reconstruct(document)
  local mount = assert(Game.mount_context())
  local scope = mount:input('scope')
  local x = ({ visit = 40, room = 420, session = 800, flow = 1180 })[scope]
  local position = Layout.clamp_to_viewport(document, x, 220, 12)
  document.style.left = position.x .. 'px'
  document.style.top = position.y .. 'px'
  layout_counter_ui.read(document)
end

function layout_counter_ui.stock()
  local stock, _, err = Game.prop('panel-stock')
  if err then error(err) end
  checked(Game.set_prop('panel-stock', stock + 1))
  checked(Room('layout-counter'):set_prop('panel-label', 'Stock changed'))
end

function layout_counter_ui.commit(document)
  local mount = assert(Game.mount_context())
  local scope = mount:input('scope')
  local state = assert(mount:state(scope))
  checked(mount:commit_state(scope, {
    count = state.count + 1,
    details = { label = 'committed', optional = mount.null },
    samples = { 1, mount.null, 2.5 }
  }))
  noveltea.notify(scope .. ' Slot committed. Read bindings after the ordered input settles.')
end

function layout_counter_ui.clear(document)
  local mount = assert(Game.mount_context())
  checked(mount:clear_state(mount:input('scope')))
  noveltea.notify('Slot cleared; Read bindings restores its declared default.')
end

function layout_counter_ui.reject(document)
  local mount = assert(Game.mount_context())
  local scope = mount:input('scope')
  local state = assert(mount:state(scope))
  state.extra = 'not declared'
  local ok = mount:commit_state(scope, state)
  assert(not ok)
  noveltea.notify('Strict shape rejected the extra field; prior Slot remains authoritative.')
end

function layout_counter_ui.invalid_input()
  local policy = options('visit')
  policy.inputs.stock = 'not an integer'
  local ok, err = noveltea.layouts.mount('visit-panel', 'visit-counter', policy)
  if not ok then
    noveltea.notify(tostring(err))
  else
    noveltea.notify('Invalid update submitted for ordered validation. Inspect the attributed diagnostic and prior visit panel; Restart recovers.')
  end
end

function layout_counter_ui.signal()
  local mount = assert(Game.mount_context())
  local state = assert(mount:state(mount:input('scope')))
  checked(mount:signal('accepted', { count = state.count }))
  noveltea.notify('Typed accepted(count) submitted to this exact owner. The Flow signal workflow is shared with Scene Director.')
end

function layout_counter_ui.update()
  local scope = Game.mount_context():input('scope')
  if scope == 'flow' then return end
  local policy = options(scope)
  policy.inputs.caption = 'Literal updated ' .. scope
  policy.order = 10
  checked(noveltea.layouts.mount(scope .. '-panel', scope .. '-counter', policy))
  noveltea.notify('Literal and compatible order updated; transient input draft should remain.')
end

function layout_counter_ui.swap()
  checked(noveltea.layouts.mount('visit-panel', 'room-counter', options('visit')))
  noveltea.notify('Visit key now uses a different resource; transient draft resets. Reopen panels restores the original resource.')
end

function layout_counter_ui.hide()
  local scope = Game.mount_context():input('scope')
  if scope == 'flow' then
    noveltea.notify('Continue the Scene to end its Flow panel.')
    return
  end
  local policy = options(scope)
  policy.visible = false
  checked(noveltea.layouts.mount(scope .. '-panel', scope .. '-counter', policy))
end

function layout_counter_ui.unmount()
  local scope = Game.mount_context():input('scope')
  if scope == 'flow' then
    noveltea.notify('Continue the Scene to end its Flow panel.')
    return
  end
  checked(noveltea.layouts.unmount(scope .. '-panel', options(scope)))
end
