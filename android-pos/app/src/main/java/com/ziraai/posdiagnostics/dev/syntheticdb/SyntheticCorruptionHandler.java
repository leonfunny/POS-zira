package com.ziraai.posdiagnostics.dev.syntheticdb;

import android.content.Context;
import android.database.DatabaseErrorHandler;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteDatabaseCorruptException;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Preserves corrupt synthetic database files and locks the logical database until owner review. */
final class SyntheticCorruptionHandler implements DatabaseErrorHandler {
    static final String QUARANTINE_DIRECTORY = "synthetic-db-corruption";

    private final Context context;
    private final String databaseName;

    SyntheticCorruptionHandler(Context context, String databaseName) {
        this.context = context.getApplicationContext();
        this.databaseName = databaseName;
    }

    @Override
    public void onCorruption(SQLiteDatabase database) {
        String databasePath = database.getPath();
        File root = quarantineRoot();
        if (!root.exists() && !root.mkdirs()) {
            throw new IllegalStateException("Cannot create synthetic corruption quarantine");
        }
        File incident = new File(
            root,
            safeDatabaseName() + "-" + System.currentTimeMillis() + "-" + Math.abs(System.nanoTime())
        );
        if (!incident.mkdir()) throw new IllegalStateException("Cannot create synthetic corruption incident");

        File marker = markerFile();
        writeAndSync(
            marker,
            "LOCKED\nincident=" + incident.getAbsolutePath() + "\nsource=" + databasePath + "\n"
        );

        try {
            database.close();
        } catch (RuntimeException ignored) {
            // The persistent lock already prevents a replacement database from opening.
        }

        StringBuilder manifest = new StringBuilder();
        manifest.append("Synthetic corruption incident; no file was intentionally deleted.\n");
        preserveAndRecord(new File(databasePath), incident, manifest);
        preserveAndRecord(new File(databasePath + "-wal"), incident, manifest);
        preserveAndRecord(new File(databasePath + "-shm"), incident, manifest);
        preserveAndRecord(new File(databasePath + "-journal"), incident, manifest);
        writeAndSync(new File(incident, "manifest.txt"), manifest.toString());

        // SQLiteDatabase.open() normally retries immediately after a corruption callback.
        // Abort that retry so Android cannot create a blank replacement behind the lock.
        throw new SQLiteDatabaseCorruptException("Synthetic database quarantined and locked");
    }

    void assertNotLocked() {
        if (markerFile().exists()) {
            throw new IllegalStateException("Synthetic database is locked after a corruption incident");
        }
    }

    File markerFile() {
        return new File(quarantineRoot(), safeDatabaseName() + ".lock");
    }

    File quarantineRoot() {
        return new File(context.getNoBackupFilesDir(), QUARANTINE_DIRECTORY);
    }

    private String safeDatabaseName() {
        return databaseName.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private void preserveAndRecord(File source, File incident, StringBuilder manifest) {
        if (!source.exists()) {
            manifest.append("absent ").append(source.getAbsolutePath()).append('\n');
            return;
        }
        File target = new File(incident, source.getName());
        File temporary = new File(incident, source.getName() + ".tmp");
        String sourceHash = sha256OrError(source);
        try {
            Files.copy(source.toPath(), temporary.toPath());
            syncExistingFile(temporary);
            String temporaryHash = sha256OrError(temporary);
            if (!sourceHash.equals(temporaryHash) || sourceHash.startsWith("ERROR-")) {
                throw new IOException("synthetic quarantine hash verification failed");
            }
            try {
                Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailure) {
                Files.move(temporary.toPath(), target.toPath());
            }
            if (!target.exists() || !sourceHash.equals(sha256OrError(target))) {
                throw new IOException("published quarantine copy failed verification");
            }
            manifest.append("copied-and-verified ")
                .append(source.getAbsolutePath())
                .append(" -> ")
                .append(target.getAbsolutePath())
                .append(" bytes=")
                .append(target.length())
                .append(" source-sha256=")
                .append(sourceHash)
                .append(" target-sha256=")
                .append(sha256OrError(target))
                .append('\n');
        } catch (IOException error) {
            manifest.append("preservation-failed ")
                .append(source.getAbsolutePath())
                .append(" error=")
                .append(error.getClass().getSimpleName())
                .append(" source-retained=")
                .append(source.exists())
                .append('\n');
        }
    }

    private void syncExistingFile(File target) throws IOException {
        try (FileOutputStream output = new FileOutputStream(target, true)) {
            output.flush();
            output.getFD().sync();
        }
    }

    private String sha256OrError(File file) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (FileInputStream input = new FileInputStream(file)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
            }
            StringBuilder hex = new StringBuilder();
            for (byte value : digest.digest()) hex.append(String.format("%02x", value));
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException error) {
            return "ERROR-" + error.getClass().getSimpleName();
        }
    }

    private void writeAndSync(File target, String value) {
        try (FileOutputStream output = new FileOutputStream(target, false)) {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            output.flush();
            output.getFD().sync();
        } catch (IOException error) {
            throw new IllegalStateException("Cannot persist synthetic corruption evidence", error);
        }
    }
}
