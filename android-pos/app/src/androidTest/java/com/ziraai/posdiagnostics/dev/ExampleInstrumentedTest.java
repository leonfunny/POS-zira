package com.ziraai.posdiagnostics.dev;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    private void assertStaticDiagnosticLoaded(ActivityScenario<MainActivity> scenario) throws Exception {
        AtomicReference<String> title = new AtomicReference<>();
        for (int attempt = 0; attempt < 20; attempt += 1) {
            CountDownLatch callback = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                assertNotNull(activity.getBridge());
                assertNotNull(activity.getBridge().getWebView());
                activity.getBridge().getWebView().evaluateJavascript(
                    "document.getElementById('diagnostic-title')?.textContent",
                    value -> {
                        title.set(value);
                        callback.countDown();
                    }
                );
            });
            if (callback.await(1, TimeUnit.SECONDS)
                && "\"Stage 1 diagnostic\"".equals(title.get())) {
                return;
            }
            Thread.sleep(250);
        }
        assertEquals("WebView diagnostic did not load before the deadline", "\"Stage 1 diagnostic\"", title.get());
    }

    @Test
    public void usesDevelopmentApplicationId() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("com.ziraai.posdiagnostics.dev", appContext.getPackageName());
    }

    @Test
    public void staticShellSurvivesActivityRecreation() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            assertStaticDiagnosticLoaded(scenario);
            scenario.recreate();
            assertStaticDiagnosticLoaded(scenario);
        }
    }
}
