feature_lab = feature_lab or {}
feature_lab.catalog = assert(Data.load('feature-lab-catalog'))
feature_lab.query = feature_lab.query or ''
feature_lab.recent_only = feature_lab.recent_only or false

local function escape(text)
  local value = tostring(text or '')
  value = value:gsub('&', '&amp;'):gsub('<', '&lt;'):gsub('>', '&gt;'):gsub('"', '&quot;')
  return value
end

local function lower(text)
  return string.lower(tostring(text or ''))
end

local function calendar_scalar(year, month, day, hour, minute, second)
  if month <= 2 then
    year = year - 1
    month = month + 12
  end
  local era = math.floor(year / 400)
  local year_of_era = year - era * 400
  local day_of_year = math.floor((153 * (month - 3) + 2) / 5) + day - 1
  local day_of_era = year_of_era * 365 + math.floor(year_of_era / 4) - math.floor(year_of_era / 100) + day_of_year
  return (era * 146097 + day_of_era) * 86400 + hour * 3600 + minute * 60 + second
end

local function timestamp_utc_scalar(timestamp)
  local year, month, day, hour, minute, second = timestamp:match('^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)')
  if not year then return nil end
  local fraction = timestamp:match('%.(%d%d%d)Z$')
  return calendar_scalar(tonumber(year), tonumber(month), tonumber(day), tonumber(hour), tonumber(minute), tonumber(second))
    + (fraction and tonumber(fraction) / 1000 or 0)
end

local function now_utc_scalar()
  local value = os.date('!*t', os.time())
  return calendar_scalar(value.year, value.month, value.day, value.hour, value.min, value.sec)
end

local function within_day(timestamp)
  local value = timestamp_utc_scalar(timestamp)
  if not value then return false end
  local age = now_utc_scalar() - value
  return age >= 0 and age <= 24 * 60 * 60
end

local function effective_modified(scenario)
  local result = scenario.modified
  local result_value = timestamp_utc_scalar(result)
  for _, check in ipairs(scenario.checks) do
    local check_value = timestamp_utc_scalar(check.modified)
    if check_value and (not result_value or check_value > result_value) then
      result = check.modified
      result_value = check_value
    end
  end
  return result
end

local function recent_label(created, modified)
  if within_day(created) then return 'New' end
  if within_day(modified) then return 'Updated' end
  return nil
end

local function check_matches(check, query)
  if query == '' then return true end
  local haystack = lower(check.id) .. ' ' .. lower(check.title) .. ' ' .. lower(check.description) .. ' ' .. lower(check.action) .. ' ' .. lower(check.expected)
  return haystack:find(query, 1, true) ~= nil
end

local function scenario_matches(scenario, query)
  if query == '' then return true end
  if (lower(scenario.id) .. ' ' .. lower(scenario.title) .. ' ' .. lower(scenario.description)):find(query, 1, true) then return true end
  for _, check in ipairs(scenario.checks) do
    if check_matches(check, query) then return true end
  end
  return false
end

function feature_lab.render(document)
  local results = document:GetElementById('feature-lab-results')
  if not results then return end
  local query = lower(feature_lab.query)
  local html = ''
  for _, category in ipairs(feature_lab.catalog.categories) do
    local category_html = ''
    for _, scenario in ipairs(feature_lab.catalog.scenarios) do
      if scenario.categoryId == category.id and scenario_matches(scenario, query) then
        local modified = effective_modified(scenario)
        local recent = recent_label(scenario.created, modified)
        if (not feature_lab.recent_only) or recent then
          local checks = ''
          for _, check in ipairs(scenario.checks) do
            if query == '' or check_matches(check, query) then
              local check_recent = recent_label(check.created, check.modified)
              checks = checks
                .. '<div class="feature-lab-check"><strong>' .. escape(check.title) .. '</strong>'
                .. '<span class="feature-lab-status">[' .. escape(check.status) .. ' / ' .. escape(check.verification) .. ']</span>'
                .. (check_recent and '<span class="feature-lab-recent">' .. check_recent .. '</span>' or '')
                .. '<p>' .. escape(check.action) .. '</p><p>Expected: ' .. escape(check.expected) .. '</p></div>'
            end
          end
          category_html = category_html
            .. '<div class="feature-lab-scenario"><div class="feature-lab-scenario-header"><h3>' .. escape(scenario.title) .. '</h3>'
            .. '<span class="feature-lab-status">[' .. escape(scenario.status) .. ']</span>'
            .. (recent and '<span class="feature-lab-recent">' .. recent .. '</span>' or '')
            .. '<button id="feature-lab-launch-' .. escape(scenario.id) .. '" onclick="feature_lab.launch(\'' .. escape(scenario.id) .. '\')">Launch fresh</button></div>'
            .. '<p>' .. escape(scenario.description) .. '</p>' .. checks .. '</div>'
        end
      end
    end
    if category_html ~= '' then
      html = html .. '<h2 class="feature-lab-category">' .. escape(category.title) .. '</h2>' .. category_html
    end
  end
  if html == '' then html = '<p>No Feature Lab checks match the current view.</p>' end
  results.inner_rml = html
end

function feature_lab.open(event, element, document)
  local panel = document:GetElementById('feature-lab-panel')
  if panel then panel:SetClass('hidden', false) end
  feature_lab.render(document)
end

function feature_lab.close(event, element, document)
  local panel = document:GetElementById('feature-lab-panel')
  if panel then panel:SetClass('hidden', true) end
end

function feature_lab.apply_search(event, element, document)
  local search = document:GetElementById('feature-lab-search')
  feature_lab.query = search and search.value or ''
  feature_lab.render(document)
end

function feature_lab.toggle_recent(event, element, document)
  feature_lab.recent_only = not feature_lab.recent_only
  feature_lab.render(document)
end

function feature_lab.launch(id)
  for _, scenario in ipairs(feature_lab.catalog.scenarios) do
    if scenario.id == id then
      for _, launch in ipairs(feature_lab.catalog.launches) do
        if launch.id == scenario.launch.entry then
          Game.restart({feature_lab={mode='scenario', scenario_id=id, entry_id=launch.id, room_id=launch.roomId}}, false)
          return
        end
      end
    end
  end
end

function feature_lab.fresh_home(event, element, document)
  Game.restart({feature_lab={mode='home', entry_id='home'}}, false)
end

function feature_lab.use_lever(event, element, document)
  Game.run_action('use', {target={kind='interactable', id='gate-lever-1'}})
end

function feature_lab.try_gate(event, element, document)
  -- Attempt even a locked exit so the authored rejection lifecycle remains observable.
  noveltea.navigation.via_exit('rooms-interactions-workshop', 'east-gate')
end

function feature_lab.on_show(event, element, document)
  local context = Game.startup_context()
  local panel = document:GetElementById('feature-lab-panel')
  if panel then
    local scenario = type(context) == 'table' and type(context.feature_lab) == 'table' and context.feature_lab.mode == 'scenario'
    panel:SetClass('hidden', scenario)
  end
  feature_lab.render(document)
end
