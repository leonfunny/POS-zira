// Quick script to check product prices in local DB
import initSqlJs from 'sql.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dbPath = join(process.env.APPDATA, 'zira-ai', 'pos.db');
if (!existsSync(dbPath)) { console.error('DB not found:', dbPath); process.exit(1); }

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(dbPath));

// === SHIFTS ===
console.log('=== Open Shifts (closed_at IS NULL) ===');
const shifts = db.exec(`
  SELECT id, staff_id, staff_name, opening_cash, opened_at, closed_at, closing_cash, total_sales, backend_id, synced
  FROM shifts ORDER BY opened_at DESC LIMIT 10
`);
if (shifts.length > 0) {
  for (const row of shifts[0].values) {
    const [id, sid, sname, ocash, opened, closed, ccash, sales, bid, synced] = row;
    const status = closed ? 'CLOSED' : '** OPEN **';
    console.log(`${status} | ${(id+'').substring(0,8)} | staff="${sname}" | opened=${opened} | closed=${closed || '-'} | synced=${synced}`);
  }
}

// === ORDERS without staff ===
console.log('\n=== Recent Orders (staff info) ===');
const orders = db.exec(`
  SELECT order_number, staff_id, staff_name, shift_id, status, created_at
  FROM orders ORDER BY created_at DESC LIMIT 10
`);
if (orders.length > 0) {
  for (const row of orders[0].values) {
    const [num, sid, sname, shiftId, status, created] = row;
    console.log(`${num} | staff="${sname || '-'}" | shift=${(shiftId+'').substring(0,8) || '-'} | ${status} | ${created}`);
  }
}

// === POS Store session ===
console.log('\n=== Sync Metadata ===');
const meta = db.exec("SELECT key, value FROM sync_metadata");
if (meta.length > 0) {
  for (const row of meta[0].values) console.log(`${row[0]} = ${row[1]}`);
}

db.close();
