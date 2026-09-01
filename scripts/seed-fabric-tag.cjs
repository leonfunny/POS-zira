/**
 * Inspect catalogue style ids before the editing screen exists.
 *
 * Development aid, not part of the product. The old --seed mode rewrote the
 * whole live pos.db through sql.js. A crash or power loss between truncation
 * and the completed write could destroy the POS database, and a process check
 * could not close that race. Writes are therefore deliberately disabled until
 * seeding goes through the running app's repository/IPC transaction boundary.
 *
 *   node scripts/seed-fabric-tag.cjs            # list styles, change nothing
 *   node scripts/seed-fabric-tag.cjs --seed     # refused (unsafe legacy mode)
 */
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(process.env.APPDATA || '', 'zira-ai', 'pos.db');

(async () => {
  const seeding = process.argv.includes('--seed');
  if (seeding) {
    console.error(
      'Refusing --seed: rewriting the live pos.db outside the app is unsafe. ' +
      'Create test templates through the app repository/IPC after that workflow is implemented.',
    );
    process.exit(2);
  }

  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}. Start the app once first.`);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

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
    console.log(`  ${String(s.variants).padStart(3)} variant(s)  ${s.template_id}  e.g. ${s.sample}`);
  }

  db.close();
  console.log('\nRead-only inspection complete. --seed is intentionally disabled.');
})();
