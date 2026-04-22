#!/usr/bin/env node
/**
 * Posnet Sandbox — Simulated fiscal receipt printing.
 *
 * Simulates POSNET v2 protocol: builds the same frames the real driver would
 * send to a Posnet Thermal XL2, captures the trinit/trline/trpayment/trend
 * sequence, and renders what the printer would physically produce on paper.
 *
 * Use when you don't have (or can't use) a live fiscal printer — e.g. the
 * unit is locked to read-only mode after fiscal decommission.
 */

const STX = 0x02;
const ETX = 0x03;

function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildFrame(body) {
  const bodyBytes = Buffer.from(body, 'latin1');
  const crc = crc16(bodyBytes);
  return Buffer.concat([
    Buffer.from([STX]),
    bodyBytes,
    Buffer.from('#' + crc),
    Buffer.from([ETX]),
  ]);
}

// ── Simulated printer state ────────────────────────────────────────────────
class SimulatedPosnetPrinter {
  constructor(profile) {
    this.profile = profile;
    this.log = [];
    this.tx = null;
  }

  handle(body) {
    const [cmd, ...params] = body.split('\t').filter(Boolean);
    this.log.push({ cmd, params });

    switch (cmd) {
      case 'rtcget': {
        const now = new Date();
        const s = (n) => String(n).padStart(2, '0');
        return `rtcget\tda${now.getFullYear()}${s(now.getMonth() + 1)}${s(now.getDate())}\tti${s(now.getHours())}${s(now.getMinutes())}\t`;
      }
      case 'modinf':
        return `modinf\tna${this.profile.model}\tnv${this.profile.firmware}\t`;
      case 'sernr':
        return `sernr\tse${this.profile.serial}\t`;
      case 'trinit':
        this.tx = { items: [], payments: [], total: 0 };
        return 'trinit\tok1\t';
      case 'trline': {
        const parsed = Object.fromEntries(params.map((p) => [p.slice(0, 2), p.slice(2)]));
        this.tx.items.push({
          name: parsed.na,
          vat: parsed.vt,
          price: Number(parsed.pr),
          qty: Number(parsed.il),
        });
        return 'trline\tok1\t';
      }
      case 'trpayment': {
        const parsed = Object.fromEntries(params.map((p) => [p.slice(0, 2), p.slice(2)]));
        this.tx.payments.push({ type: Number(parsed.ty), amount: Number(parsed.wa) });
        return 'trpayment\tok1\t';
      }
      case 'trend': {
        const parsed = Object.fromEntries(params.map((p) => [p.slice(0, 2), p.slice(2)]));
        this.tx.total = Number(parsed.to);
        return 'trend\tok1\t';
      }
      case 'opendrwr':
        return 'opendrwr\tok1\t';
      default:
        return `${cmd}\terr0\t`;
    }
  }
}

// ── Driver simulator ───────────────────────────────────────────────────────
function send(printer, body) {
  const frame = buildFrame(body);
  const resp = printer.handle(body);
  return { frame, resp };
}

// ── VAT / payment maps (mirrors ReceiptFormatter) ──────────────────────────
const VAT = { 23: 'A', 8: 'B', 5: 'C', 0: 'D', '-1': 'E' };
const PAY = { CASH: 0, CARD: 2, BLIK: 2 };

function printReceipt(printer, data) {
  send(printer, 'rtcget\t');
  send(printer, 'modinf\t');

  send(printer, 'trinit\tbm0\t');
  for (const it of data.items) {
    const vat = VAT[it.vatRate] ?? 'A';
    const body = `trline\tna${it.name}\tvt${vat === 'A' ? 0 : vat === 'B' ? 1 : vat === 'C' ? 2 : vat === 'D' ? 3 : 4}\tpr${it.unitPrice}\til${it.quantity.toFixed(3)}\t`;
    send(printer, body);
  }
  send(printer, `trpayment\tty${PAY[data.payment.method] ?? 0}\twa${data.payment.amount}\t`);
  send(printer, `trend\tto${data.total}\t`);
}

// ── Render ASCII receipt (mimics thermal printer 40-col output) ────────────
const W = 42;
const line = (c = '-') => c.repeat(W);
const center = (s) => {
  const pad = Math.max(0, Math.floor((W - s.length) / 2));
  return ' '.repeat(pad) + s;
};
const money = (g) => (g / 100).toFixed(2).replace('.', ',');
const row = (l, r) => {
  const space = Math.max(1, W - l.length - r.length);
  return l + ' '.repeat(space) + r;
};

function renderReceipt(printer, data, meta) {
  const tx = printer.tx;
  const out = [];
  out.push(center('F I R M A'));
  out.push(center(meta.company));
  out.push(center(meta.addressLine1));
  out.push(center(meta.addressLine2));
  out.push(center(`NIP: ${meta.nip}, REGON: ${meta.regon}`));
  out.push('');
  out.push(center('SKLEP'));
  out.push(center(meta.shopName));
  out.push(center(meta.shopAddress));
  out.push(center(meta.website));
  out.push(center(`NIP ${meta.nip}`));
  out.push('');

  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  out.push(row(ts, `#${meta.receiptNo}`));
  out.push(center('P A R A G O N   F I S K A L N Y'));
  out.push(line());

  let idx = 1;
  for (const it of tx.items) {
    const qtyStr = `${it.qty.toFixed(3)} x ${money(it.price)}`;
    const total = Math.round(it.qty * it.price);
    out.push(`${idx}. ${it.name}`);
    out.push(row(`   ${qtyStr}  ${it.vat === '0' ? 'A' : ['A', 'B', 'C', 'D', 'E'][Number(it.vat)]}`, money(total)));
    idx++;
  }
  out.push(line());

  // VAT summary
  const vatMap = new Map();
  for (const it of tx.items) {
    const code = ['A', 'B', 'C', 'D', 'E'][Number(it.vat)];
    const rate = [23, 8, 5, 0, 0][Number(it.vat)];
    const gross = Math.round(it.qty * it.price);
    const net = Math.round(gross / (1 + rate / 100));
    const vat = gross - net;
    const e = vatMap.get(code) || { net: 0, vat: 0, gross: 0, rate };
    vatMap.set(code, { rate, net: e.net + net, vat: e.vat + vat, gross: e.gross + gross });
  }
  out.push('Podsumowanie sprzedaży:');
  for (const [code, v] of vatMap) {
    out.push(row(`  Sprzedaż opodatk. PTU ${code} ${v.rate}%`, money(v.gross)));
    out.push(row(`  Kwota PTU ${code}`, money(v.vat)));
  }
  const totalVat = [...vatMap.values()].reduce((a, b) => a + b.vat, 0);
  out.push(row('Suma PTU', money(totalVat)));
  out.push(line('='));
  out.push(row('SUMA PLN', money(tx.total)));
  out.push(line('='));

  for (const p of tx.payments) {
    const label = p.type === 0 ? 'Gotówka' : p.type === 2 ? 'Karta' : 'Płatność';
    out.push(row(label, money(p.amount)));
  }
  out.push('');

  const unique = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}/${String(meta.receiptNo).padStart(4, '0')}`;
  out.push(row(`${ts}`, meta.cashier));
  out.push(row(unique, printer.profile.serial));
  out.push(center('[SANDBOX — NIE JEST TO PARAGON FISKALNY]'));
  out.push('');
  return out.join('\n');
}

// ── Demo run ───────────────────────────────────────────────────────────────
const profile = {
  model: 'POSNET THERMAL XL2',
  firmware: '3.03',
  serial: 'CES 1801068025',
};

const meta = {
  company: 'ROYAL FASHION VIPOL SP. Z O.O.',
  addressLine1: 'ALEJE JEROZOLIMSKIE 214',
  addressLine2: '02-486 WARSZAWA',
  nip: '5223103395',
  regon: '368499313',
  shopName: 'ROYAL FASHION',
  shopAddress: 'UL. CHMIELNA 6, 00-020 WARSZAWA',
  website: 'www.royalfashion.pl',
  receiptNo: 4836,
  cashier: 'K001 KIEROWNIK',
};

const receipt = {
  items: [
    { name: 'Sukienka wieczorowa czerwona', quantity: 1, unitPrice: 29900, vatRate: 23 },
    { name: 'Szpilki skórzane czarne r.38',  quantity: 1, unitPrice: 24900, vatRate: 23 },
    { name: 'Torebka Paris mini',            quantity: 1, unitPrice: 15900, vatRate: 23 },
    { name: 'Skarpetki bawełniane 3-pack',    quantity: 2, unitPrice: 2500,  vatRate: 8  },
  ],
  payment: { method: 'CARD', amount: 75700 },
  total: 75700,
};

const printer = new SimulatedPosnetPrinter(profile);
printReceipt(printer, receipt);

console.log('═══════════════════════════════════════════════');
console.log('   POSNET SANDBOX — Simulated fiscal print     ');
console.log('═══════════════════════════════════════════════');
console.log();
console.log(`Printer: ${profile.model}  FW ${profile.firmware}`);
console.log(`Serial : ${profile.serial}`);
console.log(`Frames sent: ${printer.log.length}`);
console.log('Commands  :', printer.log.map((l) => l.cmd).join(' → '));
console.log();
console.log('─── PAPER OUTPUT ──────────────────────────────');
console.log();
console.log(renderReceipt(printer, receipt, meta));
console.log('─── END OF PAPER ──────────────────────────────');
