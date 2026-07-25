#include <SDL3/SDL_main.h>

#include "editor_preview_app.hpp"

int main(int argc, char* argv[])
{
    noveltea::editor_preview::App app;
    return app.run(argc, argv);
}
