package org.noveltea.benchmark;

import android.graphics.Color;
import android.util.Base64;
import android.util.Log;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import org.libsdl.app.SDLActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Independent SDL Activity for the developer benchmark APK. */
public class BenchmarkActivity extends SDLActivity {
    private View emptyBenchmarkCover;
    private String unattendedConfigPath;
    private boolean unattendedConfigStaged;

    /** Never hand bgfx an Android window while the device is asleep or our
     * Activity has lost focus. SDL_main can start after onPause when launched
     * through ADB against an already sleeping device. */
    public boolean isBenchmarkLaunchReady() {
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        return power != null && power.isInteractive() && hasWindowFocus()
                && !isFinishing() && !isDestroyed();
    }

    /** The production Engine's Android Platform uses this readiness contract.
     * Both the benchmark and Engine hosts share this Activity during transitions. */
    public boolean isPlayerGraphicsReady() {
        return isBenchmarkLaunchReady();
    }

    /**
     * An empty bgfx frame deliberately has no clear or draws. EGL swap buffers need not
     * preserve their contents, so a static Android window cover prevents stale dashboard
     * pixels from flickering during that reference workload. This is not an ImGui or bgfx
     * frame and is installed outside the benchmark's timed phases.
     *
     * SDL invokes the benchmark from its native thread, not Android's UI thread.
     */
    public boolean setEmptyBenchmarkCover(boolean visible) {
        if (Thread.currentThread() == getMainLooper().getThread()) {
            updateEmptyBenchmarkCover(visible);
            return true;
        }
        CountDownLatch applied = new CountDownLatch(1);
        AtomicBoolean succeeded = new AtomicBoolean(true);
        runOnUiThread(() -> {
            try {
                updateEmptyBenchmarkCover(visible);
            } catch (RuntimeException error) {
                succeeded.set(false);
            } finally {
                applied.countDown();
            }
        });
        try {
            return applied.await(3, TimeUnit.SECONDS) && succeeded.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private void updateEmptyBenchmarkCover(boolean visible) {
        if (emptyBenchmarkCover == null && visible) {
            emptyBenchmarkCover = new View(this);
            emptyBenchmarkCover.setBackgroundColor(Color.BLACK);
            emptyBenchmarkCover.setClickable(true);
            emptyBenchmarkCover.setFocusable(false);
            emptyBenchmarkCover.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            getWindow().addContentView(emptyBenchmarkCover,
                    new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT));
        }
        if (emptyBenchmarkCover != null) {
            emptyBenchmarkCover.setVisibility(visible ? View.VISIBLE : View.GONE);
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // SDLActivity calls getArguments during its onCreate. Publish an app-private
        // configuration before that point, not in a native frame or from JNI.
        String encoded = getIntent().getStringExtra("novelteaBenchmarkConfigBase64");
        if (encoded != null) {
            Log.i("NovelTeaBenchmark", "Received canonical config intent (bytes encoded="
                    + encoded.length() + ")");
            File config = new File(getFilesDir(), "unattended-config.json");
            unattendedConfigPath = config.getAbsolutePath();
            try {
                if (config.exists() && !config.delete()) {
                    throw new IOException("unable to discard stale unattended config");
                }
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (bytes.length < 1 || bytes.length > 8192) {
                    throw new IllegalArgumentException("configuration must contain 1..8192 bytes");
                }
                try (FileOutputStream stream = new FileOutputStream(config)) {
                    stream.write(bytes);
                }
                unattendedConfigStaged = true;
            } catch (IllegalArgumentException | IOException error) {
                // Preserve --config even on failure: native startup must fail
                // explicitly instead of silently opening the interactive UI.
                config.delete();
                Log.e("NovelTeaBenchmark", "Unable to stage canonical config", error);
            }
        }
        super.onCreate(savedInstanceState);
        enterImmersiveMode();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersiveMode();
    }

    @Override
    protected String[] getLibraries() {
        return new String[]{"SDL3", "noveltea-benchmark-app"};
    }

    @Override
    protected String getMainFunction() {
        return "SDL_main";
    }

    @Override
    protected String[] getArguments() {
        if (unattendedConfigPath != null) {
            Log.i("NovelTeaBenchmark", "Passing --config to SDL_main");
            // An empty path is rejected by the native argument parser. Never
            // read a possibly stale file if staging failed.
            return new String[]{"--config", unattendedConfigStaged ? unattendedConfigPath : ""};
        }
        String arguments = getIntent().getStringExtra("novelteaBenchmarkArgs");
        if (arguments == null || arguments.trim().isEmpty()) {
            Log.i("NovelTeaBenchmark", "Passing empty arguments to SDL_main");
            return new String[0];
        }
        // ADB script supplies flag/value tokens, without shell quoting.
        return arguments.trim().split("\\s+");
    }

    private void enterImmersiveMode() {
        Window window = getWindow();
        window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false);
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
