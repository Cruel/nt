#pragma once

#include <string>
#include <vector>

namespace Rml {

using StringList = std::vector<std::string>;

inline void ReleaseFontRasterResources() {}
inline bool SetFallbackFontFamilies(const StringList&) { return true; }

} // namespace Rml
