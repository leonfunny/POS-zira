package com.ziraai.posdiagnostics.dev.syntheticdb;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Two-phase probe driven explicitly by adb around an uninstall/reinstall boundary. */
@RunWith(AndroidJUnit4.class)
public final class SyntheticReinstallProbeInstrumentedTest {
    private static final String DATABASE_NAME = "b2-reinstall-probe.db";
    private static final String PREFERENCES_NAME = "b2-reinstall-probe";
    private static final String SENTINEL_NAME = "b2-reinstall-sentinel";

    @Test
    public void executeRequestedReinstallPhase() {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String phase = InstrumentationRegistry.getArguments().getString("reinstallPhase");
        Assume.assumeTrue("Host-only reinstall probe requires reinstallPhase", phase != null);

        if (phase.equals("seed")) {
            context.deleteDatabase(DATABASE_NAME);
            try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
                SyntheticLedgerRepository repository = new SyntheticLedgerRepository(helper);
                repository.seedFakeCatalog("DEMO-REINSTALL", "Synthetic Reinstall Probe", 1);
                repository.submitFakeOrder(
                    "local-order-reinstall",
                    "command-reinstall",
                    "key-reinstall",
                    "attempt-reinstall",
                    "hash-reinstall",
                    Arrays.asList(new SyntheticLedgerRepository.FakeItem("DEMO-REINSTALL", 1))
                );
                repository.checkpointWalFully();
            }
            assertTrue(context.getDatabasePath(DATABASE_NAME).exists());
            writeSentinel(new File(context.getFilesDir(), SENTINEL_NAME));
            writeSentinel(new File(context.getNoBackupFilesDir(), SENTINEL_NAME));
            writeSentinel(new File(context.createDeviceProtectedStorageContext().getFilesDir(), SENTINEL_NAME));
            File externalRoot = context.getExternalFilesDir(null);
            if (externalRoot == null) fail("External app storage is unavailable on the test AVD");
            writeSentinel(new File(externalRoot, SENTINEL_NAME));
            assertTrue(context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean(SENTINEL_NAME, true).commit());
            assertTrue(context.createDeviceProtectedStorageContext()
                .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean(SENTINEL_NAME, true).commit());
            return;
        }

        if (phase.equals("verify")) {
            assertFalse(
                "Uninstall/reinstall must not restore the synthetic POS database",
                context.getDatabasePath(DATABASE_NAME).exists()
            );
            assertFalse(new File(context.getFilesDir(), SENTINEL_NAME).exists());
            assertFalse(new File(context.getNoBackupFilesDir(), SENTINEL_NAME).exists());
            assertFalse(new File(context.createDeviceProtectedStorageContext().getFilesDir(), SENTINEL_NAME).exists());
            File externalRoot = context.getExternalFilesDir(null);
            if (externalRoot == null) fail("External app storage is unavailable on the test AVD");
            assertFalse(new File(externalRoot, SENTINEL_NAME).exists());
            assertFalse(context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .contains(SENTINEL_NAME));
            assertFalse(context.createDeviceProtectedStorageContext()
                .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
                .contains(SENTINEL_NAME));
            return;
        }

        fail("Expected explicit reinstallPhase=seed|verify, received: " + phase);
    }

    private void writeSentinel(File target) {
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            output.write("synthetic-only".getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        } catch (IOException error) {
            throw new IllegalStateException("Cannot write synthetic reinstall sentinel", error);
        }
        assertTrue(target.exists());
    }
}
