noveltea_demo = noveltea_demo or {
    clicks = 0
}

noveltea.log("RMLUI_LUA_TEST_OK")

function noveltea_demo.on_click(event, element, document)
    noveltea_demo.clicks = noveltea_demo.clicks + 1

    local button = document:GetElementById("demo_btn")
    local status = document:GetElementById("status_box")

    button.inner_rml = "Lua clicks: " .. tostring(noveltea_demo.clicks)
    status.inner_rml = noveltea.echo(
        "Lua " .. noveltea.lua_version() ..
        " / sol2 " .. noveltea.sol_version()
    )
end
