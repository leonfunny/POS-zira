package com.ziraai.posdiagnostics.dev.syntheticdb;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import java.util.List;

/** Feature-oriented synthetic repository. It deliberately exposes no raw-SQL or generic bridge API. */
public final class SyntheticLedgerRepository {
    public static final class FakeItem {
        public final String catalogId;
        public final int quantity;

        public FakeItem(String catalogId, int quantity) {
            this.catalogId = catalogId;
            this.quantity = quantity;
        }
    }

    private final SyntheticLedgerOpenHelper helper;

    public SyntheticLedgerRepository(SyntheticLedgerOpenHelper helper) {
        this.helper = helper;
    }

    public void seedFakeCatalog(String catalogId, String name, long priceMinor) {
        ContentValues values = new ContentValues();
        values.put("catalog_id", catalogId);
        values.put("name", name);
        values.put("price_minor", priceMinor);
        helper.getWritableDatabase().insertOrThrow("fake_catalog", null, values);
    }

    public void submitFakeOrder(
        String localOrderId,
        String orderCommandId,
        String idempotencyKey,
        String clientAttemptId,
        String payloadHash,
        List<FakeItem> items
    ) {
        submitFakeOrder(
            localOrderId,
            orderCommandId,
            idempotencyKey,
            clientAttemptId,
            payloadHash,
            items,
            false
        );
    }

    void submitFakeOrder(
        String localOrderId,
        String orderCommandId,
        String idempotencyKey,
        String clientAttemptId,
        String payloadHash,
        List<FakeItem> items,
        boolean failAfterItemsForTest
    ) {
        if (items.isEmpty()) throw new IllegalArgumentException("A synthetic order needs at least one item");

        SQLiteDatabase database = helper.getWritableDatabase();
        database.beginTransaction();
        try {
            ContentValues order = new ContentValues();
            order.put("local_order_id", localOrderId);
            order.put("created_at", "2026-07-17T00:00:00.000Z");
            database.insertOrThrow("fake_orders", null, order);

            for (int position = 0; position < items.size(); position += 1) {
                FakeItem item = items.get(position);
                ContentValues line = new ContentValues();
                line.put("local_order_id", localOrderId);
                line.put("line_position", position);
                line.put("catalog_id", item.catalogId);
                line.put("quantity", item.quantity);
                database.insertOrThrow("fake_order_items", null, line);
            }

            if (failAfterItemsForTest) throw new SQLiteException("synthetic rollback injection");

            ContentValues journal = new ContentValues();
            journal.put("local_order_id", localOrderId);
            journal.put("order_command_id", orderCommandId);
            journal.put("idempotency_key", idempotencyKey);
            journal.put("client_attempt_id", clientAttemptId);
            journal.put("payload_hash", payloadHash);
            journal.put("state", "STAGED");
            database.insertOrThrow("fake_order_upload_journal", null, journal);

            database.setTransactionSuccessful();
        } finally {
            database.endTransaction();
        }
    }

    public int count(String table) {
        if (!table.equals("fake_catalog")
            && !table.equals("fake_orders")
            && !table.equals("fake_order_items")
            && !table.equals("fake_order_upload_journal")) {
            throw new IllegalArgumentException("Unknown synthetic table");
        }
        try (Cursor cursor = helper.getReadableDatabase().rawQuery("SELECT COUNT(*) FROM " + table, null)) {
            cursor.moveToFirst();
            return cursor.getInt(0);
        }
    }

    public long catalogRevision(String catalogId) {
        try (Cursor cursor = helper.getReadableDatabase().query(
            "fake_catalog",
            new String[] { "catalog_revision" },
            "catalog_id = ?",
            new String[] { catalogId },
            null,
            null,
            null
        )) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("Missing synthetic catalog row");
            return cursor.getLong(0);
        }
    }

    public String journalPayloadHashByKey(String keyColumn, String value) {
        if (!keyColumn.equals("order_command_id")
            && !keyColumn.equals("idempotency_key")
            && !keyColumn.equals("client_attempt_id")) {
            throw new IllegalArgumentException("Unsupported synthetic lineage key");
        }
        try (Cursor cursor = helper.getReadableDatabase().query(
            "fake_order_upload_journal",
            new String[] { "payload_hash" },
            keyColumn + " = ?",
            new String[] { value },
            null,
            null,
            null
        )) {
            if (!cursor.moveToFirst()) throw new IllegalStateException("Missing synthetic journal lineage");
            return cursor.getString(0);
        }
    }

    public void deleteFakeOrder(String localOrderId) {
        helper.getWritableDatabase().delete(
            "fake_orders",
            "local_order_id = ?",
            new String[] { localOrderId }
        );
    }

    public String journalMode() {
        try (Cursor cursor = helper.getReadableDatabase().rawQuery("PRAGMA journal_mode", null)) {
            cursor.moveToFirst();
            return cursor.getString(0);
        }
    }

}
