Layout = Layout or {}

local function finite_number(value, name)
    if type(value) ~= "number" or value ~= value or value == math.huge or value == -math.huge then
        error(name .. " must be a finite number", 3)
    end
    return value
end

function Layout.clamp_to_viewport(element, x, y, padding)
    if element == nil then
        error("element is required", 2)
    end
    x = finite_number(x, "x")
    y = finite_number(y, "y")
    padding = finite_number(padding == nil and 0 or padding, "padding")
    if padding < 0 then
        error("padding must be non-negative", 2)
    end

    local document = element.owner_document
    local context = document ~= nil and document.context or nil
    if context == nil then
        error("element must belong to a document with a context", 2)
    end

    local viewport = context.dimensions
    local max_x = viewport.x - element.offset_width - padding
    local max_y = viewport.y - element.offset_height - padding
    local clamped_x = max_x < padding and padding or math.max(padding, math.min(x, max_x))
    local clamped_y = max_y < padding and padding or math.max(padding, math.min(y, max_y))

    return {
        x = clamped_x,
        y = clamped_y,
        clamped_x = clamped_x ~= x,
        clamped_y = clamped_y ~= y,
    }
end
