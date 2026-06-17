#pragma once

#include "ui/rmlui/rmlui_file_interface.hpp"

namespace noveltea {
#if defined(NOVELTEA_HAS_RMLUI)
using AssetRmlFileInterface = ui::rmlui::AssetRmlFileInterface;
#endif
} // namespace noveltea
