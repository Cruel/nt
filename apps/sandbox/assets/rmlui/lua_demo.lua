noveltea_demo = noveltea_demo or {
    clicks = 0,
    pitch = 1.0,
}

noveltea.log("RMLUI_LUA_TEST_OK")

local function event_document(event, element, document)
    if document ~= nil then
        return document
    end
    if element ~= nil and element.GetOwnerDocument ~= nil then
        return element:GetOwnerDocument()
    end
    if event ~= nil and event.current_element ~= nil and event.current_element.GetOwnerDocument ~= nil then
        return event.current_element:GetOwnerDocument()
    end
    if event ~= nil and event.target_element ~= nil and event.target_element.GetOwnerDocument ~= nil then
        return event.target_element:GetOwnerDocument()
    end
    return nil
end

local function slider_pitch(document, element)
    local slider = nil
    if document ~= nil then
        slider = document:GetElementById("pitch_slider")
    end
    if slider == nil then
        slider = element
    end
    if slider == nil then
        return noveltea_demo.pitch or 1.0
    end

    local value = tonumber(slider.value)
    if value == nil and slider.GetAttribute ~= nil then
        value = tonumber(slider:GetAttribute("value", "1.0"))
    end
    if value == nil then
        value = noveltea_demo.pitch or 1.0
    end
    return value
end

local function update_pitch_label(document, pitch)
    if document == nil then
        return
    end
    local label = document:GetElementById("pitch_value")
    if label ~= nil then
        label.inner_rml = string.format("%.2fx", pitch)
    end
end

function noveltea_demo.on_click(event, element, document)
    document = event_document(event, element, document)
    noveltea_demo.clicks = noveltea_demo.clicks + 1

    if document == nil then
        return
    end

    local button = document:GetElementById("demo_btn")
    local status = document:GetElementById("status_box")

    button.inner_rml = "Lua clicks: " .. tostring(noveltea_demo.clicks)
    status.inner_rml = noveltea.echo(
        "Lua " .. noveltea.lua_version() ..
        " / sol2 " .. noveltea.sol_version()
    )
end

function noveltea_demo.on_pitch_change(event, element, document)
    document = event_document(event, element, document)
    noveltea_demo.pitch = slider_pitch(document, element)
    update_pitch_label(document, noveltea_demo.pitch)
end

function noveltea_demo.play_notification(event, element, document)
    document = event_document(event, element, document)
    noveltea_demo.pitch = slider_pitch(document, nil)
    update_pitch_label(document, noveltea_demo.pitch)

    local ok = audio.play_sfx("project:/audio/notification.mp3", {
        volume = 1.0,
        pitch = noveltea_demo.pitch,
        max_simultaneous = 8,
    })

    if document ~= nil then
        local status = document:GetElementById("status_box")
        if status ~= nil then
            if ok then
                status.inner_rml = string.format("Played notification at %.2fx pitch", noveltea_demo.pitch)
            else
                status.inner_rml = "Audio playback failed or is unavailable"
            end
        end
    end
end
