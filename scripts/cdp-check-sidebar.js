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
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
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
      expression, returnByValue: true, awaitPromise: false,
    });
    const inner = result.result && result.result.result;
    if (inner && inner.value !== undefined) return inner.value;
    return JSON.stringify(result);
  }

  // Check all sidebar items (including hidden ones)
  console.log('=== Sidebar Items ===');
  const sidebar = await evaluate(`
    (function() {
      // Find sidebar
      var sidebar = document.querySelector('[class*="sidebar"], [class*="Sidebar"], nav');
      if (!sidebar) {
        // Try finding by structure
        var root = document.getElementById('root');
        sidebar = root ? root.querySelector('[class*="w-16"], [class*="w-20"], [class*="w-64"]') : null;
      }

      // Get all clickable items in sidebar area
      var items = [];
      var buttons = document.querySelectorAll('button, a, [role="button"]');
      buttons.forEach(function(btn) {
        var text = btn.textContent.trim();
        var rect = btn.getBoundingClientRect();
        // Items in left sidebar area (x < 200)
        if (rect.left < 200 && rect.width > 0 && text.length > 0 && text.length < 30) {
          var style = getComputedStyle(btn);
          items.push({
            text: text,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            w: Math.round(rect.width),
            visible: btn.offsetWidth > 0,
            opacity: style.opacity,
            display: style.display,
            color: style.color
          });
        }
      });

      // Also check for POS specifically
      var allText = document.body.textContent;
      var hasPOS = allText.indexOf('POS') >= 0;
      var hasPointOfSale = allText.indexOf('Point of Sale') >= 0;

      return JSON.stringify({
        sidebarFound: !!sidebar,
        items: items,
        hasPOS: hasPOS,
        hasPointOfSale: hasPointOfSale
      });
    })()
  `);
  console.log(sidebar);

  // Check current active tab and billiard colors
  console.log('\n=== Billiard Floor Plan Colors ===');
  const colors = await evaluate(`
    (function() {
      var tables = document.querySelectorAll('.select-none');
      var samples = [];
      tables.forEach(function(t) {
        var text = t.textContent.trim();
        if ((text.indexOf('Pool') >= 0 || text.indexOf('Snooker') >= 0) && text.length < 100) {
          var inner = t.querySelector('[class*="rounded"]');
          var nameEl = t.querySelector('span, p, div');
          samples.push({
            name: text.substring(0, 30),
            bgColor: inner ? getComputedStyle(inner).backgroundColor : 'unknown',
            textColor: nameEl ? getComputedStyle(nameEl).color : 'unknown',
            fontSize: nameEl ? getComputedStyle(nameEl).fontSize : 'unknown'
          });
        }
      });

      // Check header/stats area colors
      var header = document.querySelector('h1, h2');
      var headerColor = header ? getComputedStyle(header).color : 'unknown';

      return JSON.stringify({
        headerColor: headerColor,
        tableCount: samples.length,
        tables: samples.slice(0, 3)
      });
    })()
  `);
  console.log(colors);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
