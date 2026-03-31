const WebSocket = require('ws');
const http = require('http');

async function run() {
  const list = await new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  const page = list.find(p => p.title === 'Zira AI');
  if (!page) { console.log('No Zira AI page found'); return; }

  const client = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => client.on('open', r));

  let id = 0;
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error('timeout for ' + method)), 15000);
      const handler = (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === myId) {
          clearTimeout(timer);
          client.removeListener('message', handler);
          resolve(msg);
        }
      };
      client.on('message', handler);
      client.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
  }

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    const inner = result.result && result.result.result;
    if (inner && inner.value !== undefined) return inner.value;
    if (inner && inner.description) return inner.description;
    return JSON.stringify(result);
  }

  // Check what the rendered UI shows
  console.log('=== UI State Check ===');

  // Check rendered table cards in the floor plan
  const uiState = await evaluate(`
    (function() {
      // Check visible table status badges/text
      var selectNones = document.querySelectorAll('.select-none');
      var tables = [];
      selectNones.forEach(function(el) {
        var text = el.textContent.trim();
        if (text.indexOf('Pool') >= 0 || text.indexOf('Snooker') >= 0) {
          // Check for status indicators
          var hasActive = text.indexOf('ACTIVE') >= 0 || text.indexOf('active') >= 0;
          var hasFree = text.indexOf('free') >= 0 || text.indexOf('Free') >= 0;
          var hasOccupied = text.indexOf('occupied') >= 0;
          var bgColor = getComputedStyle(el.querySelector('[class*="rounded"]') || el).backgroundColor;
          tables.push({
            name: text.substring(0, 40),
            hasActive: hasActive,
            hasFree: hasFree,
            bgColor: bgColor
          });
        }
      });

      // Check stats bar
      var statsBar = document.querySelector('[class*="stats"], [class*="summary"]');
      var statsText = statsBar ? statsBar.textContent.substring(0, 200) : 'no stats bar found';

      // Check main heading
      var h1 = document.querySelector('h1, h2');
      var heading = h1 ? h1.textContent : 'no heading';

      return JSON.stringify({
        heading: heading,
        tableCount: tables.length,
        tables: tables.slice(0, 5),
        stats: statsText
      });
    })()
  `);
  console.log(uiState);

  // Check if there are any active sessions shown in the floor plan header
  console.log('\n=== Floor Plan Header ===');
  const header = await evaluate(`
    (function() {
      var mainArea = document.querySelector('main') || document.querySelector('[class*="flex-1"]');
      if (!mainArea) return JSON.stringify({ error: 'no main area' });

      // Get all text content in header area
      var firstChild = mainArea.children[0];
      return JSON.stringify({
        headerText: firstChild ? firstChild.textContent.substring(0, 300) : 'none',
        headerClasses: firstChild ? firstChild.className.substring(0, 100) : 'none'
      });
    })()
  `);
  console.log(header);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
