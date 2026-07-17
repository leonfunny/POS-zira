package com.ziraai.posdiagnostics.dev.syntheticdb;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.XmlResourceParser;
import android.database.sqlite.SQLiteConstraintException;
import android.database.sqlite.SQLiteException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.xmlpull.v1.XmlPullParser;

@RunWith(AndroidJUnit4.class)
public final class SyntheticLedgerInstrumentedTest {
    private static final String DATABASE_NAME = "b2-synthetic-ledger.db";
    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase(DATABASE_NAME);
    }

    @After
    public void tearDown() {
        context.deleteDatabase(DATABASE_NAME);
    }

    private SyntheticLedgerRepository repository(SyntheticLedgerOpenHelper helper) {
        SyntheticLedgerRepository repository = new SyntheticLedgerRepository(helper);
        repository.seedFakeCatalog("DEMO-001", "Synthetic Gel", 4900);
        return repository;
    }

    private void submit(SyntheticLedgerRepository repository, String suffix) {
        repository.submitFakeOrder(
            "local-order-" + suffix,
            "command-" + suffix,
            "android-order:v1:demo:terminal:" + suffix,
            "attempt-" + suffix,
            "hash-" + suffix,
            Arrays.asList(new SyntheticLedgerRepository.FakeItem("DEMO-001", 2))
        );
    }

    @Test
    public void commitsOrderItemsAndUploadIntentAtomicallyAndSurvivesReopen() {
        try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = repository(helper);
            submit(repository, "atomic");
            assertEquals(1, repository.count("fake_orders"));
            assertEquals(1, repository.count("fake_order_items"));
            assertEquals(1, repository.count("fake_order_upload_journal"));
            assertEquals("wal", repository.journalMode().toLowerCase());
        }

        try (SyntheticLedgerOpenHelper reopened = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = new SyntheticLedgerRepository(reopened);
            assertEquals(1, repository.count("fake_orders"));
            assertEquals(1, repository.count("fake_order_items"));
            assertEquals(1, repository.count("fake_order_upload_journal"));
        }
    }

    @Test
    public void rollsBackOrderAndItemsWhenJournalCannotCommit() {
        try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = repository(helper);
            try {
                repository.submitFakeOrder(
                    "local-order-rollback",
                    "command-rollback",
                    "key-rollback",
                    "attempt-rollback",
                    "hash-rollback",
                    Arrays.asList(new SyntheticLedgerRepository.FakeItem("DEMO-001", 1)),
                    true
                );
                fail("Expected synthetic rollback injection");
            } catch (SQLiteException expected) {
                assertEquals("synthetic rollback injection", expected.getMessage());
            }
            assertEquals(0, repository.count("fake_orders"));
            assertEquals(0, repository.count("fake_order_items"));
            assertEquals(0, repository.count("fake_order_upload_journal"));
        }
    }

    @Test
    public void everyConcurrentJournalKeyConflictHasOneWinnerAndNoOrphanRows() throws Exception {
        runJournalKeyRace("order_command_id");
        runJournalKeyRace("idempotency_key");
        runJournalKeyRace("client_attempt_id");
    }

    private void runJournalKeyRace(String conflictColumn) throws Exception {
        context.deleteDatabase(DATABASE_NAME);
        try (SyntheticLedgerOpenHelper seedHelper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            repository(seedHelper);
        }

        AtomicInteger winners = new AtomicInteger();
        AtomicInteger constraints = new AtomicInteger();
        AtomicReference<Throwable> unexpected = new AtomicReference<>();
        AtomicReference<String> winningHash = new AtomicReference<>();
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch finished = new CountDownLatch(2);

        java.util.function.Consumer<String> contender = suffix -> {
            try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
                start.await();
                try {
                    String payloadHash = "hash-" + suffix;
                    new SyntheticLedgerRepository(helper).submitFakeOrder(
                        "local-order-" + suffix,
                        conflictColumn.equals("order_command_id") ? "shared-lineage" : "command-" + suffix,
                        conflictColumn.equals("idempotency_key") ? "shared-lineage" : "key-" + suffix,
                        conflictColumn.equals("client_attempt_id") ? "shared-lineage" : "attempt-" + suffix,
                        payloadHash,
                        Arrays.asList(new SyntheticLedgerRepository.FakeItem("DEMO-001", 2))
                    );
                    winningHash.set(payloadHash);
                    winners.incrementAndGet();
                } catch (SQLiteConstraintException expected) {
                    constraints.incrementAndGet();
                }
            } catch (Throwable error) {
                unexpected.compareAndSet(null, error);
            } finally {
                finished.countDown();
            }
        };
        new Thread(() -> contender.accept(conflictColumn + "-a"), "synthetic-ledger-race-1").start();
        new Thread(() -> contender.accept(conflictColumn + "-b"), "synthetic-ledger-race-2").start();
        start.countDown();
        assertTrue("Race workers did not finish", finished.await(15, java.util.concurrent.TimeUnit.SECONDS));
        if (unexpected.get() != null) throw new AssertionError(unexpected.get());
        assertEquals(1, winners.get());
        assertEquals(1, constraints.get());

        try (SyntheticLedgerOpenHelper reopened = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = new SyntheticLedgerRepository(reopened);
            assertEquals(1, repository.count("fake_orders"));
            assertEquals(1, repository.count("fake_order_items"));
            assertEquals(1, repository.count("fake_order_upload_journal"));
            assertEquals(
                winningHash.get(),
                repository.journalPayloadHashByKey(conflictColumn, "shared-lineage")
            );
        }
    }

    @Test
    public void foreignKeysRejectMissingCatalogAndCascadeOrderDeletion() {
        try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = repository(helper);
            try {
                repository.submitFakeOrder(
                    "local-order-invalid-fk",
                    "command-invalid-fk",
                    "key-invalid-fk",
                    "attempt-invalid-fk",
                    "hash-invalid-fk",
                    Arrays.asList(new SyntheticLedgerRepository.FakeItem("DEMO-MISSING", 1))
                );
                fail("Expected missing-catalog foreign-key failure");
            } catch (SQLiteConstraintException expected) {
                assertTrue(expected.getMessage() != null && !expected.getMessage().isEmpty());
            }
            assertEquals(0, repository.count("fake_orders"));
            assertEquals(0, repository.count("fake_order_items"));
            assertEquals(0, repository.count("fake_order_upload_journal"));

            submit(repository, "cascade");
            repository.deleteFakeOrder("local-order-cascade");
            assertEquals(0, repository.count("fake_orders"));
            assertEquals(0, repository.count("fake_order_items"));
            assertEquals(0, repository.count("fake_order_upload_journal"));
        }
    }

    @Test
    public void migratesV1ToV2AndPreservesData() {
        try (SyntheticLedgerOpenHelper v1 = new SyntheticLedgerOpenHelper(
            context,
            DATABASE_NAME,
            SyntheticLedgerOpenHelper.SCHEMA_V1,
            false
        )) {
            new SyntheticLedgerRepository(v1).seedFakeCatalog("DEMO-001", "Synthetic Gel", 4900);
        }

        try (SyntheticLedgerOpenHelper v2 = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = new SyntheticLedgerRepository(v2);
            assertEquals(1, repository.count("fake_catalog"));
            assertEquals(1L, repository.catalogRevision("DEMO-001"));
        }
    }

    @Test
    public void failedMigrationRollsBackAndOriginalDatabaseRemainsReadable() {
        try (SyntheticLedgerOpenHelper v1 = new SyntheticLedgerOpenHelper(
            context,
            DATABASE_NAME,
            SyntheticLedgerOpenHelper.SCHEMA_V1,
            false
        )) {
            new SyntheticLedgerRepository(v1).seedFakeCatalog("DEMO-001", "Synthetic Gel", 4900);
        }

        try (SyntheticLedgerOpenHelper failingV2 = new SyntheticLedgerOpenHelper(
            context,
            DATABASE_NAME,
            SyntheticLedgerOpenHelper.SCHEMA_V2,
            true
        )) {
            failingV2.getWritableDatabase();
            fail("Expected deliberate migration failure");
        } catch (SQLiteException expected) {
            assertTrue(expected.getMessage() != null && !expected.getMessage().isEmpty());
        }

        try (SyntheticLedgerOpenHelper originalV1 = new SyntheticLedgerOpenHelper(
            context,
            DATABASE_NAME,
            SyntheticLedgerOpenHelper.SCHEMA_V1,
            false
        )) {
            assertEquals(1, new SyntheticLedgerRepository(originalV1).count("fake_catalog"));
        }
        try (SyntheticLedgerOpenHelper recoveredV2 = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            assertEquals(1L, new SyntheticLedgerRepository(recoveredV2).catalogRevision("DEMO-001"));
        }
    }

    @Test
    public void manifestAndBothBackupRuleFormatsExcludeDurableState() throws Exception {
        ApplicationInfo applicationInfo = context.getPackageManager().getApplicationInfo(context.getPackageName(), 0);
        assertFalse((applicationInfo.flags & ApplicationInfo.FLAG_ALLOW_BACKUP) != 0);

        Set<String> expectedLegacy = new HashSet<>(Arrays.asList("root:.", "file:.", "database:.", "sharedpref:.", "external:."));
        Map<String, Set<String>> legacy = excludedPathsBySection("backup_rules");
        assertTrue(legacy.getOrDefault("full-backup-content", new HashSet<>()).containsAll(expectedLegacy));

        Set<String> expectedModern = new HashSet<>(Arrays.asList(
            "root:.",
            "file:.",
            "database:.",
            "sharedpref:.",
            "external:.",
            "device_root:.",
            "device_file:.",
            "device_database:.",
            "device_sharedpref:."
        ));
        Map<String, Set<String>> modern = excludedPathsBySection("data_extraction_rules");
        assertTrue(modern.getOrDefault("cloud-backup", new HashSet<>()).containsAll(expectedModern));
        assertTrue(modern.getOrDefault("device-transfer", new HashSet<>()).containsAll(expectedModern));
    }

    private Map<String, Set<String>> excludedPathsBySection(String resourceName) throws Exception {
        int resourceId = context.getResources().getIdentifier(resourceName, "xml", context.getPackageName());
        assertTrue(resourceName + " must be compiled", resourceId != 0);
        Map<String, Set<String>> sections = new HashMap<>();
        String currentSection = null;
        try (XmlResourceParser parser = context.getResources().getXml(resourceId)) {
            for (int event = parser.getEventType(); event != XmlPullParser.END_DOCUMENT; event = parser.next()) {
                if (event == XmlPullParser.START_TAG) {
                    String name = parser.getName();
                    if (name.equals("full-backup-content") || name.equals("cloud-backup") || name.equals("device-transfer")) {
                        currentSection = name;
                        sections.putIfAbsent(name, new HashSet<>());
                    } else if (name.equals("exclude") && currentSection != null) {
                        sections.get(currentSection).add(
                            parser.getAttributeValue(null, "domain") + ":" + parser.getAttributeValue(null, "path")
                        );
                    }
                } else if (event == XmlPullParser.END_TAG && parser.getName().equals(currentSection)) {
                    currentSection = null;
                }
            }
        }
        return sections;
    }
}
