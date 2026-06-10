package com.example.noveltea;

import org.libsdl.app.SDLActivity;

/**
 * Main activity for NovelTea.
 *
 * Extends SDLActivity which handles native library loading, input events,
 * and the GLSurfaceView lifecycle.
 *
 * TODO: Add any Android-specific lifecycle overrides here if needed.
 *       For now, SDLActivity provides everything required.
 */
public class MainActivity extends SDLActivity {

    @Override
    protected String[] getLibraries() {
        return new String[]{
            "SDL3",
            "noveltea-sandbox"  // Our native library (CMake target)
        };
    }

    @Override
    protected String getMainFunction() {
        return "SDL_main";
    }
}
