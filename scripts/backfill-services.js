/**
 * One-shot repair: re-apply service/service_rule entries that were
 * pulled into local_sync_log on 2026-04-24 BEFORE the applicators
 * existed (commit 7c7c4ec). Without this, the table stays empty until
 * the next server-side change forces a new pull.
 *
 * USAGE: app must be CLOSED before running this. SQL.js auto-saves
 * every 5s in the running app and will clobber our writes otherwise.
 *
 *   node scripts/backfill-services.js
 *
 * Idempotent — UPSERT with updated_at guard. Safe to run multiple times.
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(process.env.APPDATA || '', 'zira-ai', 'pos.db');

function plnToGrosze(value) {
  if (value == null) return 0;
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (!isFinite(num)) return 0;
  return Math.round(num * 100);
}

(async () => {
  console.log('Reading', DB_PATH);
  const SQL = await initSqlJs({
    locateFile: f => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f),
  });
  const buf = fs.readFileSync(DB_PATH);
  const db = new SQL.Database(buf);

  const before = {
    services: db.exec('SELECT COUNT(*) FROM services')[0].values[0][0],
    service_rules: db.exec('SELECT COUNT(*) FROM service_rules')[0].values[0][0],
  };
  console.log('Before:', before);

  const r = db.exec(`
    SELECT id, entity_type, entity_id, event, payload, created_at
    FROM local_sync_log
    WHERE entity_type IN ('service','service_rule') AND status='accepted'
    ORDER BY id ASC
  `);
  if (!r[0]) {
    console.log('No stuck entries found.');
    return;
  }

  let svcCount = 0, ruleCount = 0, skipped = 0;
  for (const row of r[0].values) {
    const [, entity_type, entity_id, event, payloadStr, created_at] = row;
    if (!entity_id) { skipped++; continue; }
    let p;
    try { p = JSON.parse(payloadStr); } catch { skipped++; continue; }

    if (entity_type === 'service') {
      if (event === 'deleted') {
        db.run('UPDATE services SET is_active = 0 WHERE id = ?', [entity_id]);
        svcCount++;
        continue;
      }
      db.run(
        `INSERT INTO services (id,name,description,icon_url,is_active,base_price_pln,price_net_pln,tax_rate_id,base_duration_minutes,processing_time_minutes,processing_start_after,buffer_before,buffer_after,display_order,category_id,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, description=excluded.description, icon_url=excluded.icon_url,
           is_active=excluded.is_active, base_price_pln=excluded.base_price_pln,
           price_net_pln=excluded.price_net_pln, tax_rate_id=excluded.tax_rate_id,
           base_duration_minutes=excluded.base_duration_minutes,
           processing_time_minutes=excluded.processing_time_minutes,
           processing_start_after=excluded.processing_start_after,
           buffer_before=excluded.buffer_before, buffer_after=excluded.buffer_after,
           display_order=excluded.display_order, category_id=excluded.category_id,
           updated_at=excluded.updated_at
         WHERE excluded.updated_at IS NULL OR services.updated_at IS NULL OR excluded.updated_at >= services.updated_at`,
        [
          entity_id,
          p.name ?? '',
          p.description ?? null,
          p.icon_url ?? p.iconUrl ?? null,
          (p.is_active ?? p.isActive) === false ? 0 : 1,
          plnToGrosze(p.base_price_pln ?? p.basePricePln ?? p.base_price ?? p.basePrice),
          p.price_net_pln != null ? plnToGrosze(p.price_net_pln) : (p.priceNet != null ? plnToGrosze(p.priceNet) : null),
          p.tax_rate_id ?? p.taxRateId ?? null,
          p.base_duration_minutes ?? p.baseDurationMinutes ?? 60,
          p.processing_time_minutes ?? p.processingTimeMinutes ?? 0,
          p.processing_start_after ?? p.processingStartAfter ?? 0,
          p.buffer_before ?? p.bufferBefore ?? 0,
          p.buffer_after ?? p.bufferAfter ?? 0,
          p.display_order ?? p.displayOrder ?? 0,
          p.category_id ?? p.categoryId ?? null,
          p.updated_at ?? p.updatedAt ?? created_at,
        ]
      );
      svcCount++;
    } else if (entity_type === 'service_rule') {
      if (event === 'deleted') {
        db.run('DELETE FROM service_rules WHERE id = ?', [entity_id]);
        ruleCount++;
        continue;
      }
      const serviceId = p.service_id ?? p.serviceId;
      if (!serviceId) { skipped++; continue; }
      db.run(
        `INSERT INTO service_rules (id,service_id,size_category,duration_min,base_price_pln,deposit_pln,name,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           service_id=excluded.service_id, size_category=excluded.size_category,
           duration_min=excluded.duration_min, base_price_pln=excluded.base_price_pln,
           deposit_pln=excluded.deposit_pln, name=excluded.name, updated_at=excluded.updated_at
         WHERE excluded.updated_at IS NULL OR service_rules.updated_at IS NULL OR excluded.updated_at >= service_rules.updated_at`,
        [
          entity_id,
          serviceId,
          p.size_category ?? p.sizeCategory ?? null,
          p.duration_min ?? p.durationMin ?? 60,
          plnToGrosze(p.base_price_pln ?? p.basePricePln),
          plnToGrosze(p.deposit_pln ?? p.depositPln),
          p.name ?? null,
          p.updated_at ?? p.updatedAt ?? created_at,
        ]
      );
      ruleCount++;
    }
  }

  const after = {
    services: db.exec('SELECT COUNT(*) FROM services')[0].values[0][0],
    service_rules: db.exec('SELECT COUNT(*) FROM service_rules')[0].values[0][0],
  };

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  console.log(`Applied: ${svcCount} services, ${ruleCount} service_rules (skipped ${skipped})`);
  console.log('After:', after);
  console.log('DB saved.');
})();
