// Call the product API directly and inspect actual retailPrice values
import { readFileSync } from 'fs';
import { join } from 'path';

const configPath = join(process.env.APPDATA, 'zira-ai', 'config.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const serverUrl = config.serverUrl || 'https://api.enail.pro';
const apiKey = config.apiKey;
const salonSlug = config.salonSlug;

if (!apiKey) { console.error('No API key found'); process.exit(1); }

console.log(`Server: ${serverUrl}`);
console.log(`Salon: ${salonSlug || '(none)'}`);
console.log(`API Key: ${apiKey.substring(0, 10)}...\n`);

const headers = {
  'x-api-key': apiKey,
  'Content-Type': 'application/json',
};
if (salonSlug) headers['X-Salon-Slug'] = salonSlug;

try {
  const url = `${serverUrl}/api/v1/warehouse/public/products?limit=100&page=1`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    console.error(`API error: ${res.status} ${res.statusText}`);
    const body = await res.text().catch(() => '');
    console.error(body.substring(0, 500));
    process.exit(1);
  }

  const data = await res.json();
  const items = data.items ?? data.products ?? [];

  console.log(`=== API Response (first ${items.length} products) ===\n`);
  console.log('name | retailPrice | type | priceGross | priceNet');
  console.log('-'.repeat(80));

  for (const item of items.slice(0, 15)) {
    const name = (item.name || item.template?.name || '?').substring(0, 25);
    const rp = item.retailPrice;
    const rpType = typeof rp;
    const pg = item.priceGross;
    const pn = item.priceNet;
    console.log(`${name.padEnd(26)}| ${String(rp).padEnd(13)}| ${rpType.padEnd(8)}| ${pg} | ${pn}`);
  }

  // Show raw JSON of first item for full inspection
  if (items.length > 0) {
    const sample = items.find(i => (i.name || '').toLowerCase().includes('bưởi') || (i.name || '').toLowerCase().includes('buoi')) || items[0];
    console.log(`\n=== Raw JSON sample: "${sample.name || sample.template?.name}" ===`);
    const { template, ...rest } = sample;
    console.log(JSON.stringify(rest, null, 2));
    if (template) {
      console.log('\ntemplate:', JSON.stringify(template, null, 2));
    }
  }
} catch (err) {
  console.error('Fetch failed:', err.message);
}
