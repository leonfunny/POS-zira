/**
 * Headless fabric-tag bench.
 *
 * Runs the real print path -- the same renderFabricTagBitmap and TscDriver the
 * app uses -- without the Electron UI, so a layout can be iterated over SSH.
 * Writes the exact 1-bit bitmap that would reach the print head as a PNG, and
 * only sends it to the printer when --print is passed.
 *
 *   npx electron zz-fabric-probe.cjs --tag tag.json --width 20 --height 32 --out out.png [--print]
 */
const fs = require('node:fs');
const zlib = require('node:zlib');
const { app } = require('electron');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

/** Minimal 8-bit greyscale PNG so the packed bitmap can be eyeballed. */
function writeGreyPng(file, width, height, pixels) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(typed) >>> 0 : crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  function crc32(buf) {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Unpack MonoBitmap (bit 0 = burn) into one grey byte per dot. */
function monoToPixels(bmp) {
  const out = Buffer.alloc(bmp.widthDots * bmp.heightDots, 0xff);
  let black = 0;
  for (let y = 0; y < bmp.heightDots; y++) {
    for (let x = 0; x < bmp.widthDots; x++) {
      const bit = (bmp.data[y * bmp.widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit === 0) { out[y * bmp.widthDots + x] = 0x00; black++; }
    }
  }
  return { out, black };
}

/** Columns actually burnt, so overflow past the media edge is measurable. */
function inkBounds(bmp) {
  let minX = bmp.widthDots, maxX = -1, minY = bmp.heightDots, maxY = -1;
  for (let y = 0; y < bmp.heightDots; y++) {
    for (let x = 0; x < bmp.widthDots; x++) {
      const bit = (bmp.data[y * bmp.widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      if (bit === 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}

/**
 * A ruler the width of the declared label, so the mapping from bitmap column
 * to physical ribbon position can be read off the fabric instead of guessed.
 *
 * Top band spans x=0..width-1 solid: whatever of it is missing on the fabric
 * never reached the media. Ticks are 1mm, long ticks 5mm, counted from x=0.
 * The two edge blocks and the centre line show at a glance which way the
 * content sits relative to the ribbon.
 */
function buildAlignmentBitmap(widthDots, heightDots) {
  const widthBytes = Math.ceil(widthDots / 8);
  const data = Buffer.alloc(widthBytes * heightDots, 0xff);
  const burn = (x, y) => {
    if (x < 0 || y < 0 || x >= widthDots || y >= heightDots) return;
    data[y * widthBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
  };
  const rect = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) burn(x, y);
  };

  // Full-width solid band: the reference for "did the whole width land".
  rect(0, 0, widthDots - 1, 3);

  // 1mm ticks hanging off the band, every 5mm twice as long.
  for (let x = 0; x < widthDots; x += 8) {
    const long = x % 40 === 0;
    rect(x, 5, x, 5 + (long ? 15 : 6));
  }

  // Edge blocks and centre line.
  rect(0, 26, 5, 70);
  rect(widthDots - 6, 26, widthDots - 1, 70);
  rect(Math.floor(widthDots / 2) - 1, 26, Math.floor(widthDots / 2), 90);

  // A second full-width band lower down confirms the first was not a fluke.
  rect(0, heightDots - 4, widthDots - 1, heightDots - 1);

  return { widthDots, heightDots, widthBytes, data };
}

app.disableHardwareAcceleration();
// The rasteriser destroys its offscreen window, and Electron quits the app on
// Windows once the last window closes -- which killed the process mid-print.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const code = await run().catch((err) => {
    console.error('PROBE FAILED: ' + (err && err.stack || err));
    return 1;
  });
  app.exit(code);
});

async function run() {
  const { renderFabricTagBitmap } = require('./dist/main/hardware/tsc/fabric-tag-renderer');
  const { TscDriver } = require('./dist/main/hardware/tsc/tsc-driver');

  const tag = JSON.parse(fs.readFileSync(arg('tag'), 'utf8'));
  const widthMm = Number(arg('width', 20));
  const heightMm = Number(arg('height', 32));
  const printer = arg('printer', 'TSC MB241');

  const driver = new TscDriver(printer, widthMm, heightMm, {
    sensor: arg('sensor', 'none'),
    density: Number(arg('density', 12)),
    speed: Number(arg('speed', 2)),
    gapMm: 0,
  });
  const formatter = driver.formatter || driver._formatter;

  const widthDots = Math.round(widthMm * 8);
  const heightDots = Math.round(heightMm * 8);
  const bmp = has('align')
    ? buildAlignmentBitmap(widthDots, heightDots)
    : await renderFabricTagBitmap(tag, widthDots, heightDots, {
        // Mirror what TscDriver.printFabricTag does, so the PNG is the tag
        // that actually gets printed rather than a differently-sized preview.
        fitHeight: !has('no-fit'),
        minHeightDots: 15 * 8,
      });

  const { out, black } = monoToPixels(bmp);
  const bounds = inkBounds(bmp);
  writeGreyPng(arg('out', 'fabric-preview.png'), bmp.widthDots, bmp.heightDots, out);

  console.log(`BITMAP ${bmp.widthDots}x${bmp.heightDots} dots (${widthMm}x${heightMm}mm @203dpi)`);
  console.log(`INK    ${black} dots burnt (${((black / (bmp.widthDots * bmp.heightDots)) * 100).toFixed(1)}%)`);
  console.log(`BOUNDS x ${bounds.minX}..${bounds.maxX}  y ${bounds.minY}..${bounds.maxY}`);
  console.log(`EDGE   left-margin=${bounds.minX} right-margin=${bmp.widthDots - 1 - bounds.maxX} ` +
    `top=${bounds.minY} bottom=${bmp.heightDots - 1 - bounds.maxY}`);
  if (bounds.minX <= 0 || bounds.maxX >= bmp.widthDots - 1) {
    console.log('WARN   ink touches a side edge -- content is being clipped horizontally');
  }
  if (bounds.minY <= 0 || bounds.maxY >= bmp.heightDots - 1) {
    console.log('WARN   ink touches top/bottom edge -- content is being clipped vertically');
  }

  if (arg('raw')) {
    // Send bare TSPL. Used to probe for hardware we cannot query: the RAW
    // spooler path is write-only, so the only way to learn whether a cutter
    // is fitted is to ask the printer to cut and watch it.
    const { sendRawToPrinter } = require('./dist/main/hardware/windows-raw-print');
    const commands = arg('raw').split('|').map((c) => c.trim()).filter(Boolean);
    const job = Buffer.from(commands.join('\r\n') + '\r\n', 'latin1');
    console.log('RAW ->\n  ' + commands.join('\n  '));
    await sendRawToPrinter(printer, job, { docName: 'Zira TSPL Raw Probe' });
    console.log('RAW SENT');
    return 0;
  }

  if (has('print')) {
    const ok = await driver.connect();
    if (!ok) { console.error('PRINT SKIPPED: printer not reachable'); return 2; }
    if (has('align')) {
      const { TsplFormatter } = require('./dist/main/hardware/tsc/tspl-formatter');
      const { sendRawToPrinter } = require('./dist/main/hardware/windows-raw-print');
      const formatter = new TsplFormatter(widthMm, heightMm, 203, {
        sensor: arg('sensor', 'none'),
        density: Number(arg('density', 12)),
        speed: Number(arg('speed', 2)),
        gapMm: 0,
      });
      const job = formatter.formatFabricTag({ brandName: '', quantity: 1 }, bmp);
      await sendRawToPrinter(printer, job, { docName: 'Zira Fabric Alignment' });
      console.log('PRINTED (alignment ruler)');
    } else {
      await driver.printFabricTag(tag);
      console.log('PRINTED');
    }
  } else {
    console.log('DRY RUN (no --print)');
  }
  return 0;
}
