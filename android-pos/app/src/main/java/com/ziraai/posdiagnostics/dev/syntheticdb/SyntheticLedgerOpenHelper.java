package com.ziraai.posdiagnostics.dev.syntheticdb;

import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

/** Development-only schema used to prove Android ledger invariants with synthetic data. */
public final class SyntheticLedgerOpenHelper extends SQLiteOpenHelper {
    public static final int SCHEMA_V1 = 1;
    public static final int SCHEMA_V2 = 2;

    private final int targetVersion;
    private final boolean failV2MigrationForTest;
    private final SyntheticCorruptionHandler corruptionHandler;

    public SyntheticLedgerOpenHelper(Context context, String databaseName) {
        this(context, databaseName, SCHEMA_V2, false);
    }

    SyntheticLedgerOpenHelper(
        Context context,
        String databaseName,
        int targetVersion,
        boolean failV2MigrationForTest
    ) {
        this(
            context,
            databaseName,
            targetVersion,
            failV2MigrationForTest,
            new SyntheticCorruptionHandler(context, databaseName)
        );
    }

    private SyntheticLedgerOpenHelper(
        Context context,
        String databaseName,
        int targetVersion,
        boolean failV2MigrationForTest,
        SyntheticCorruptionHandler corruptionHandler
    ) {
        super(context, databaseName, null, targetVersion, corruptionHandler);
        this.targetVersion = targetVersion;
        this.failV2MigrationForTest = failV2MigrationForTest;
        this.corruptionHandler = corruptionHandler;
        corruptionHandler.assertNotLocked();
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public SQLiteDatabase getWritableDatabase() {
        corruptionHandler.assertNotLocked();
        return super.getWritableDatabase();
    }

    @Override
    public SQLiteDatabase getReadableDatabase() {
        corruptionHandler.assertNotLocked();
        return super.getReadableDatabase();
    }

    @Override
    public void onConfigure(SQLiteDatabase database) {
        super.onConfigure(database);
        database.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase database) {
        createV1Schema(database);
        if (targetVersion >= SCHEMA_V2) migrateV1ToV2(database);
    }

    @Override
    public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
        if (oldVersion < SCHEMA_V2 && newVersion >= SCHEMA_V2) migrateV1ToV2(database);
    }

    private void createV1Schema(SQLiteDatabase database) {
        database.execSQL(
            "CREATE TABLE fake_catalog ("
                + "catalog_id TEXT PRIMARY KEY NOT NULL,"
                + "name TEXT NOT NULL,"
                + "price_minor INTEGER NOT NULL CHECK(price_minor >= 0)"
                + ")"
        );
        database.execSQL(
            "CREATE TABLE fake_orders ("
                + "local_order_id TEXT PRIMARY KEY NOT NULL,"
                + "created_at TEXT NOT NULL"
                + ")"
        );
        database.execSQL(
            "CREATE TABLE fake_order_items ("
                + "item_id INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "local_order_id TEXT NOT NULL,"
                + "line_position INTEGER NOT NULL,"
                + "catalog_id TEXT NOT NULL,"
                + "quantity INTEGER NOT NULL CHECK(quantity > 0),"
                + "UNIQUE(local_order_id, line_position),"
                + "FOREIGN KEY(local_order_id) REFERENCES fake_orders(local_order_id) ON DELETE CASCADE,"
                + "FOREIGN KEY(catalog_id) REFERENCES fake_catalog(catalog_id)"
                + ")"
        );
        database.execSQL(
            "CREATE TABLE fake_order_upload_journal ("
                + "local_order_id TEXT PRIMARY KEY NOT NULL,"
                + "order_command_id TEXT NOT NULL UNIQUE,"
                + "idempotency_key TEXT NOT NULL UNIQUE,"
                + "client_attempt_id TEXT NOT NULL UNIQUE,"
                + "payload_hash TEXT NOT NULL,"
                + "state TEXT NOT NULL CHECK(state IN ('STAGED','DISPATCHING','UNKNOWN','ACKED','REJECTED_TERMINAL')),"
                + "FOREIGN KEY(local_order_id) REFERENCES fake_orders(local_order_id) ON DELETE CASCADE"
                + ")"
        );
    }

    private void migrateV1ToV2(SQLiteDatabase database) {
        database.execSQL(
            "ALTER TABLE fake_catalog ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 1"
        );
        if (failV2MigrationForTest) {
            database.execSQL("CREATE TABLE deliberate_migration_failure (");
        }
    }
}
