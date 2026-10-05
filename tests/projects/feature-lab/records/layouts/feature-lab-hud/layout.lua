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
  local haystack = lower(check.id) .. ' ' .. lower(check.title) .. ' ' .. lower(check.description) .. ' ' .. lower(check.action) .. ' ' .. lower(check.expected) .. ' ' .. lower(check.guideSubtext)
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

local function scenario_by_id(id)
  for _, scenario in ipairs(feature_lab.catalog.scenarios) do
    if scenario.id == id then return scenario end
  end
  return nil
end

local function matching_check_titles(scenario, query)
  if query == '' then return '' end
  local matches = {}
  for _, check in ipairs(scenario.checks) do
    if check_matches(check, query) then matches[#matches + 1] = check.title end
  end
  if #matches == 0 then return '' end
  return '<span class="feature-lab-match">Matches: ' .. escape(table.concat(matches, ', ')) .. '</span>'
end

function feature_lab.render(document)
  local results = document:GetElementById('feature-lab-results')
  if not results then return end
  local query = lower(feature_lab.query)
  local links = '<button id="feature-lab-category-all" onclick="feature_lab.choose_category(event, element, document)">All categories</button>'
  for _, category in ipairs(feature_lab.catalog.categories) do
    links = links .. '<button id="feature-lab-category-' .. escape(category.id) .. '" onclick="feature_lab.choose_category(event, element, document)">' .. escape(category.title) .. '</button>'
  end
  local categories = document:GetElementById('feature-lab-categories')
  if not categories:HasChildNodes() then categories.inner_rml = links end
  local html = ''
  for _, category in ipairs(feature_lab.catalog.categories) do
    local category_html = ''
    for _, scenario in ipairs(feature_lab.catalog.scenarios) do
      if scenario.categoryId == category.id and (not feature_lab.category or category.id == feature_lab.category) and scenario_matches(scenario, query) then
        local modified = effective_modified(scenario)
        local recent = recent_label(scenario.created, modified)
        if (not feature_lab.recent_only) or recent then
          category_html = category_html
            .. '<button class="feature-lab-scenario" id="feature-lab-launch-' .. escape(scenario.id) .. '" onclick="feature_lab.launch(event, element, document)">'
            .. '<span class="feature-lab-scenario-main"><span class="feature-lab-scenario-title">' .. escape(scenario.title) .. '</span>'
            .. '<span class="feature-lab-status">[' .. escape(scenario.status) .. ' / ' .. tostring(#scenario.checks) .. ' checks]</span>'
            .. (recent and '<span class="feature-lab-recent">' .. recent .. '</span>' or '')
            .. '</span>' .. matching_check_titles(scenario, query) .. '</button>'
        end
      end
    end
    if category_html ~= '' then
      html = html
        .. '<section class="feature-lab-category"><h2>' .. escape(category.title) .. '</h2>'
        .. '<div class="feature-lab-scenario-grid">' .. category_html .. '</div></section>'
    end
  end
  if html == '' then html = '<p>No Feature Lab checks match the current view.</p>' end
  results.inner_rml = html
end

function feature_lab.render_scenario_guide(document, scenario_id)
  local guide = document:GetElementById('feature-lab-scenario-guide')
  if not guide then return end
  local scenario = scenario_by_id(scenario_id)
  if not scenario then
    guide:SetClass('hidden', true)
    return
  end
  local html = '<h2>' .. escape(scenario.title) .. '</h2>'
  for index, check in ipairs(scenario.checks) do
    html = html
      .. '<div class="feature-lab-check"><div class="feature-lab-check-instruction">'
      .. '<span class="feature-lab-check-number">' .. tostring(index) .. '.</span>'
      .. '<span>' .. escape(check.action) .. '</span></div>'
      .. (check.guideSubtext and '<p class="feature-lab-check-subtext">' .. escape(check.guideSubtext) .. '</p>' or '')
      .. '</div>'
  end
  guide.inner_rml = html
  guide:SetClass('hidden', false)
end

function feature_lab.sync_scenario_guide(document)
  local guide = document:GetElementById('feature-lab-scenario-guide')
  if not guide then return end
  local context = Game.startup_context()
  local lab = type(context) == 'table' and type(context.feature_lab) == 'table' and context.feature_lab or nil
  if lab and lab.mode == 'scenario' and lab.scenario_id then
    feature_lab.render_scenario_guide(document, lab.scenario_id)
  else
    guide:SetClass('hidden', true)
  end
end

function feature_lab.open(event, element, document)
  local panel = document:GetElementById('feature-lab-panel')
  local guide = document:GetElementById('feature-lab-scenario-guide')
  if panel then panel:SetClass('hidden', false) end
  if guide then guide:SetClass('hidden', true) end
  feature_lab.render(document)
end

function feature_lab.close(event, element, document)
  local panel = document:GetElementById('feature-lab-panel')
  if panel then panel:SetClass('hidden', true) end
  feature_lab.sync_scenario_guide(document)
end

function feature_lab.choose_category(event, element, document)
  local id = element.id:sub(#'feature-lab-category-' + 1)
  feature_lab.category = id ~= 'all' and id or nil
  feature_lab.render(document)
  document:GetElementById('feature-lab-panel').scroll_top = 0
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

local function restart_scenario(id)
  local scenario = scenario_by_id(id)
  if not scenario then return end
  for _, launch in ipairs(feature_lab.catalog.launches) do
    if launch.id == scenario.launch.entry then
      Game.restart({feature_lab={mode='scenario', scenario_id=id, entry_id=launch.id, room_id=launch.roomId}}, false)
      return
    end
  end
end

function feature_lab.launch(event, element, document)
  local prefix = 'feature-lab-launch-'
  local element_id = element and element.id or ''
  local id = element_id:sub(1, #prefix) == prefix and element_id:sub(#prefix + 1) or ''
  local panel = document and document:GetElementById('feature-lab-panel') or nil
  if panel then panel:SetClass('hidden', true) end
  restart_scenario(id)
end

function feature_lab.restart_current(event, element, document)
  local context = Game.startup_context()
  local lab = type(context) == 'table' and type(context.feature_lab) == 'table' and context.feature_lab or nil
  if lab and lab.mode == 'scenario' and lab.scenario_id then
    restart_scenario(lab.scenario_id)
  else
    feature_lab.fresh_home(event, element, document)
  end
end

function feature_lab.fresh_home(event, element, document)
  Game.restart({feature_lab={mode='home', entry_id='home'}}, false)
end

function feature_lab.on_show(event, element, document)
  local context = Game.startup_context()
  local scenario = type(context) == 'table' and type(context.feature_lab) == 'table' and context.feature_lab.mode == 'scenario'
  local panel = document:GetElementById('feature-lab-panel')
  if panel then panel:SetClass('hidden', scenario) end
  local scenario_id = scenario and context.feature_lab.scenario_id or nil
  local story = document:GetElementById('feature-lab-text-panel')
  if story then story:SetClass('hidden', scenario_id == 'menus-and-input' or scenario_id == 'hotspots-and-cursors' or scenario_id == 'stress-content') end
  feature_lab.render(document)
  feature_lab.sync_scenario_guide(document)
end
