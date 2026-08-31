/**
 * Put one care label into the local database so the Label tab has something to
 * print, before the editing screen exists.
 *
 * Development aid, not part of the product. It writes the app's own pos.db
 * through sql.js, which loads the whole file into memory and writes it back --
 * so it MUST NOT run while the app is open, or whichever process saves last
 * silently discards the other's work. The script refuses in that case.
 *
 *   node scripts/seed-fabric-tag.cjs            # list styles, change nothing
 *   node scripts/seed-fabric-tag.cjs --seed     # seed the style with most sizes
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(process.env.APPDATA || '', 'zira-ai', 'pos.db');

/** The same DDL migration 67 runs, so seeding before first launch is safe. */
const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS fabric_tag_templates (
    template_id TEXT PRIMARY KEY,
    brand_name TEXT,
    logo_data_url TEXT,
    composition TEXT,
    care_symbols TEXT,
    care_text TEXT,
    fabric TEXT,
    layout TEXT NOT NULL DEFAULT 'default',
    backend_id TEXT,
    synced INTEGER DEFAULT 0,
    synced_at TEXT,
    updated_at TEXT
  );
`;

function appIsRunning() {
  try {
    const out = execSync(
      'powershell.exe -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match \'electron|zira\' } | Measure-Object | Select-Object -ExpandProperty Count"',
      { encoding: 'utf8' },
    );
    return Number(out.trim()) > 0;
  } catch {
    return false;
  }
}

(async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}. Start the app once first.`);
    process.exit(1);
  }
  const seeding = process.argv.includes('--seed');
  if (seeding && appIsRunning()) {
    console.error('The POS app is running. Close it first, or its next save will discard this seed.');
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  db.run(CREATE_TABLE);

  const styles = [];
  const stmt = db.prepare(`
    SELECT template_id, COUNT(*) AS variants, MIN(name) AS sample
    FROM product_variants
    WHERE template_id IS NOT NULL AND is_active = 1
    GROUP BY template_id ORDER BY variants DESC LIMIT 8
  `);
  while (stmt.step()) styles.push(stmt.getAsObject());
  stmt.free();

  console.log(`styles with a template id: ${styles.length}`);
  for (const s of styles) {
    console.log(`  ${String(s.variants).padStart(3)} size(s)  ${s.template_id}  e.g. ${s.sample}`);
  }

  if (!seeding) {
    console.log('\nDry run. Pass --seed to write a care label for the first style.');
    db.close();
    return;
  }

  const target = styles[0];
  if (!target) {
    console.error('No style has a template id, so there is nothing to attach a care label to.');
    process.exit(1);
  }

  db.run(
    `INSERT INTO fabric_tag_templates
       (template_id, brand_name, composition, care_symbols, care_text, fabric, layout, synced, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'default', 0, datetime('now'))
     ON CONFLICT(template_id) DO UPDATE SET
       brand_name = excluded.brand_name, composition = excluded.composition,
       care_symbols = excluded.care_symbols, care_text = excluded.care_text,
       fabric = excluded.fabric, synced = 0, updated_at = datetime('now')`,
    [
      target.template_id,
      'ZIRA TEST',
      '95% BAWEŁNA · 5% ELASTAN',
      JSON.stringify(['WASH_30', 'BLEACH_NO', 'TUMBLE_NO', 'IRON_LOW', 'DRY_LINE']),
      'MADE IN POLAND',
      'Satyna poliestrowa',
    ],
  );

  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();
  console.log(`\nSeeded a care label for ${target.template_id} (${target.variants} size(s)).`);
})();
