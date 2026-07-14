noveltea_demo = noveltea_demo or {
    clicks = 0,
    volume = 1.0,
    audio_asset_id = "demo-notification",
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

local function slider_volume(document, element)
    local slider = nil
    if document ~= nil then
        slider = document:GetElementById("volume_slider")
    end
    if slider == nil then
        slider = element
    end
    if slider == nil then
        return noveltea_demo.volume or 1.0
    end

    local value = tonumber(slider.value)
    if value == nil and slider.GetAttribute ~= nil then
        value = tonumber(slider:GetAttribute("value", "1.0"))
    end
    if value == nil then
        value = noveltea_demo.volume or 1.0
    end
    return value
end

local function update_volume_label(document, volume)
    if document == nil then
        return
    end
    local label = document:GetElementById("volume_value")
    if label ~= nil then
        label.inner_rml = string.format("%.0f%%", volume * 100.0)
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

function noveltea_demo.on_volume_change(event, element, document)
    document = event_document(event, element, document)
    noveltea_demo.volume = slider_volume(document, element)
    update_volume_label(document, noveltea_demo.volume)
end

function noveltea_demo.play_notification(event, element, document)
    document = event_document(event, element, document)
    noveltea_demo.volume = slider_volume(document, nil)
    update_volume_label(document, noveltea_demo.volume)

    local ok = false
    local err = nil
    if audio ~= nil and audio.play ~= nil then
        ok, err = audio.play(noveltea_demo.audio_asset_id, "sound-effect", {
            volume = noveltea_demo.volume,
            loop = false,
        })
    else
        err = "Typed runtime audio API is unavailable"
    end

    if document ~= nil then
        local status = document:GetElementById("status_box")
        if status ~= nil then
            if ok then
                status.inner_rml = string.format(
                    "Playing %s at %.0f%% volume",
                    noveltea_demo.audio_asset_id,
                    noveltea_demo.volume * 100.0
                )
            else
                status.inner_rml = "Audio playback failed: " .. tostring(err)
            end
        end
    end
end
