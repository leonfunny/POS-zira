package com.ziraai.posdiagnostics.dev.syntheticdb;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.XmlResourceParser;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteConstraintException;
import android.database.sqlite.SQLiteDatabaseCorruptException;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteFullException;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
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
    private static final String SIDECAR_DATABASE_NAME = "b2-synthetic-sidecars.db";
    private Context context;

    @Before
    public void setUp() {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        context.deleteDatabase(DATABASE_NAME);
        context.deleteDatabase(SIDECAR_DATABASE_NAME);
        deleteQuarantineFiles();
    }

    @After
    public void tearDown() {
        context.deleteDatabase(DATABASE_NAME);
        context.deleteDatabase(SIDECAR_DATABASE_NAME);
        deleteQuarantineFiles();
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
            File walFile = new File(context.getDatabasePath(DATABASE_NAME).getPath() + "-wal");
            assertTrue("WAL must exist before the explicit checkpoint", walFile.exists());
            assertTrue("WAL must contain committed frames before the explicit checkpoint", walFile.length() > 0);
            SyntheticLedgerRepository.WalCheckpointResult checkpoint = repository.checkpointWalFully();
            assertEquals(0, checkpoint.busyStatus);
            assertTrue("Expected WAL frames before the explicit checkpoint", checkpoint.logFrames > 0);
            assertEquals(checkpoint.logFrames, checkpoint.checkpointedFrames);
            assertEquals("ok", repository.integrityCheck());
        }

        try (SyntheticLedgerOpenHelper reopened = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = new SyntheticLedgerRepository(reopened);
            assertEquals(1, repository.count("fake_orders"));
            assertEquals(1, repository.count("fake_order_items"));
            assertEquals(1, repository.count("fake_order_upload_journal"));
            assertEquals("ok", repository.integrityCheck());
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
    public void realSqliteFullRollsBackOrderWithoutFillingTheDevice() {
        try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            // Android's WAL can accept frames before a constrained main database is checkpointed.
            // Use rollback-journal mode here so the engine raises SQLITE_FULL at transaction commit.
            helper.setWriteAheadLoggingEnabled(false);
            SyntheticLedgerRepository repository = repository(helper);
            assertFalse("WAL must be disabled for the deterministic SQLITE_FULL probe", repository.journalMode().equalsIgnoreCase("wal"));
            SQLiteDatabase database = helper.getWritableDatabase();
            long pageCount = pragmaLong(database, "page_count");
            long originalMaximum = pragmaLong(database, "max_page_count");

            char[] largePayload = new char[512 * 1024];
            Arrays.fill(largePayload, 'x');
            try {
                long constrainedMaximum = pragmaLong(database, "max_page_count=" + pageCount);
                assertEquals(pageCount, constrainedMaximum);
                try {
                    repository.submitFakeOrder(
                        "local-order-full",
                        "command-full",
                        "key-full",
                        "attempt-full",
                        new String(largePayload),
                        Arrays.asList(new SyntheticLedgerRepository.FakeItem("DEMO-001", 1))
                    );
                    fail("Expected an engine-level SQLITE_FULL result");
                } catch (SQLiteFullException expected) {
                    assertTrue(expected.getMessage() != null && !expected.getMessage().isEmpty());
                }
            } finally {
                assertEquals(originalMaximum, pragmaLong(database, "max_page_count=" + originalMaximum));
            }

            assertEquals(0, repository.count("fake_orders"));
            assertEquals(0, repository.count("fake_order_items"));
            assertEquals(0, repository.count("fake_order_upload_journal"));
            assertEquals(1, repository.count("fake_catalog"));
            submit(repository, "after-full");
            assertEquals(1, repository.count("fake_orders"));
            assertEquals(1, repository.count("fake_order_items"));
            assertEquals(1, repository.count("fake_order_upload_journal"));
            assertEquals("ok", repository.integrityCheck());
        }

        try (SyntheticLedgerOpenHelper reopened = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = new SyntheticLedgerRepository(reopened);
            assertEquals(1, repository.count("fake_orders"));
            assertEquals(1, repository.count("fake_order_items"));
            assertEquals(1, repository.count("fake_order_upload_journal"));
            assertEquals("ok", repository.integrityCheck());
        }
    }

    @Test
    public void corruptDatabaseIsQuarantinedWithoutDestructiveReplacement() throws Exception {
        File databaseFile = context.getDatabasePath(DATABASE_NAME);
        try (SyntheticLedgerOpenHelper helper = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            SyntheticLedgerRepository repository = repository(helper);
            submit(repository, "corruption");
            repository.checkpointWalFully();
        }
        assertTrue(databaseFile.length() > 4096);

        try (RandomAccessFile file = new RandomAccessFile(databaseFile, "rw")) {
            file.seek(100);
            byte[] damagedSchemaPage = new byte[1024];
            Arrays.fill(damagedSchemaPage, (byte) 0x7f);
            file.write(damagedSchemaPage);
            file.getFD().sync();
        }
        String damagedHash = sha256(databaseFile);

        boolean corruptionDetected = false;
        try (SyntheticLedgerOpenHelper reopened = new SyntheticLedgerOpenHelper(context, DATABASE_NAME)) {
            new SyntheticLedgerRepository(reopened).count("fake_orders");
        } catch (SQLiteException | IllegalStateException expected) {
            corruptionDetected = true;
        }
        assertTrue("SQLite corruption must fail closed", corruptionDetected);
        SyntheticCorruptionHandler corruptionHandler = new SyntheticCorruptionHandler(context, DATABASE_NAME);
        assertTrue("A persistent corruption lock must be written", corruptionHandler.markerFile().exists());
        assertTrue("The locked corrupt source must remain for owner review", databaseFile.exists());
        assertEquals("The source path must not become a blank replacement", damagedHash, sha256(databaseFile));

        try {
            new SyntheticLedgerOpenHelper(context, DATABASE_NAME);
            fail("A second open must be blocked until the corruption incident is reviewed");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("locked"));
        }

        File[] incidents = incidentDirectories(corruptionHandler, DATABASE_NAME);
        assertEquals("Exactly one corruption incident must be retained", 1, incidents.length);
        File manifest = new File(incidents[0], "manifest.txt");
        assertTrue("The corruption incident manifest must be retained", manifest.isFile() && manifest.length() > 0);
        File[] quarantined = incidents[0].listFiles();
        assertTrue("The corrupt database bytes must be preserved", quarantined != null);
        boolean mainDatabasePreserved = false;
        for (File file : quarantined) {
            if (file.getName().equals(DATABASE_NAME) && sha256(file).equals(damagedHash)) {
                mainDatabasePreserved = true;
            }
        }
        assertTrue("The main corrupt database was not preserved byte-for-byte", mainDatabasePreserved);
    }

    @Test
    public void corruptionHandlerPreservesKnownSyntheticSidecarsByteForByte() throws Exception {
        File databaseFile = context.getDatabasePath(SIDECAR_DATABASE_NAME);
        SQLiteDatabase database = SQLiteDatabase.openOrCreateDatabase(databaseFile, null);
        database.execSQL("CREATE TABLE synthetic_sidecar_probe (id INTEGER PRIMARY KEY)");

        Map<String, String> expectedHashes = new HashMap<>();
        for (String suffix : Arrays.asList("", "-wal", "-shm", "-journal")) {
            File source = new File(databaseFile.getPath() + suffix);
            if (!suffix.isEmpty()) writeSyntheticFile(source, "synthetic-sidecar" + suffix);
            expectedHashes.put(source.getName(), sha256(source));
        }

        SyntheticCorruptionHandler handler = new SyntheticCorruptionHandler(context, SIDECAR_DATABASE_NAME);
        try {
            handler.onCorruption(database);
            fail("The corruption handler must abort Android's automatic reopen");
        } catch (SQLiteDatabaseCorruptException expected) {
            assertTrue(expected.getMessage().contains("quarantined"));
        }

        assertTrue(handler.markerFile().exists());
        File[] incidents = incidentDirectories(handler, SIDECAR_DATABASE_NAME);
        assertEquals(1, incidents.length);
        for (Map.Entry<String, String> expected : expectedHashes.entrySet()) {
            File source = new File(databaseFile.getParentFile(), expected.getKey());
            File retained = new File(incidents[0], expected.getKey());
            assertTrue("The locked source must remain: " + expected.getKey(), source.exists());
            assertTrue("The quarantine copy must exist: " + expected.getKey(), retained.exists());
            assertEquals(expected.getValue(), sha256(source));
            assertEquals(expected.getValue(), sha256(retained));
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

    private long pragmaLong(SQLiteDatabase database, String pragma) {
        try (Cursor cursor = database.rawQuery("PRAGMA " + pragma, null)) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("PRAGMA returned no row: " + pragma);
            return cursor.getLong(0);
        }
    }

    private File[] incidentDirectories(SyntheticCorruptionHandler handler, String databaseName) {
        File[] files = handler.quarantineRoot().listFiles(
            file -> file.isDirectory() && file.getName().startsWith(databaseName + "-")
        );
        return files == null ? new File[0] : files;
    }

    private void deleteQuarantineFiles() {
        SyntheticCorruptionHandler handler = new SyntheticCorruptionHandler(context, DATABASE_NAME);
        File root = handler.quarantineRoot();
        if (root.exists()) deleteRecursively(root);
    }

    private void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        if (file.exists() && !file.delete()) throw new IllegalStateException("Cannot delete test file: " + file);
    }

    private String sha256(File file) throws IOException, NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder hex = new StringBuilder();
        for (byte value : digest.digest()) hex.append(String.format("%02x", value));
        return hex.toString();
    }

    private void writeSyntheticFile(File target, String value) throws IOException {
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(target, false)) {
            output.write(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        }
    }
}
