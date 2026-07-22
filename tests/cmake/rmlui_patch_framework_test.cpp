#include <RmlUi/Core/NovelTeaPatch.h>

#include <string_view>

#ifndef RMLUI_NOVELTEA_PATCH_REVISION
#error "The repository-owned RmlUi patch marker is missing"
#endif

#ifndef NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION
#error "The expected RmlUi patch revision was not supplied by the NovelTea build"
#endif

static_assert(std::string_view(RMLUI_NOVELTEA_PATCH_REVISION) ==
              std::string_view(NOVELTEA_EXPECTED_RMLUI_PATCH_REVISION));

int main() { return 0; }
