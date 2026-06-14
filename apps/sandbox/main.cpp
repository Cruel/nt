#include <SDL3/SDL_main.h>

#include <noveltea/app.hpp>

// SDL_main.h renames this to SDL_main so SDL3 can find it on all platforms.
int main(int argc, char* argv[])
{
    noveltea::App app;
    return app.run(argc, argv);
}
