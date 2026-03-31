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
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
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

  // Find and click the billiard sidebar item
  const js = `
    (function() {
      // Find sidebar items
      var items = document.querySelectorAll('.sidebar-item');
      var found = null;
      items.forEach(function(item) {
        var text = item.textContent.trim().toLowerCase();
        if (text.indexOf('billiard') >= 0) {
          found = text;
          item.click();
        }
      });
      if (!found) {
        // Try to find by data attribute or icon
        var allButtons = document.querySelectorAll('button, [role="button"], [data-tab]');
        allButtons.forEach(function(btn) {
          var t = (btn.textContent || '').trim().toLowerCase();
          var dt = btn.dataset.tab || '';
          if (t.indexOf('billiard') >= 0 || dt === 'billiard') {
            found = 'button: ' + t + ' dt=' + dt;
            btn.click();
          }
        });
      }
      return JSON.stringify({
        clicked: found || 'not found',
        sidebarItems: Array.from(items).map(function(e) { return e.textContent.trim(); }),
        windowSize: window.innerWidth + 'x' + window.innerHeight,
      });
    })()
  `;

  const result = await send('Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });

  if (result.result && result.result.value) {
    try {
      console.log(JSON.stringify(JSON.parse(result.result.value), null, 2));
    } catch(e) {
      console.log('Raw:', result.result.value);
    }
  } else {
    console.log('Result:', JSON.stringify(result, null, 2));
  }
  client.close();
}

run().catch(e => console.error(e.message)).finally(() => setTimeout(() => process.exit(0), 500));
