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
      const timer = setTimeout(() => reject(new Error('timeout for ' + method)), 8000);
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
      awaitPromise: false,
    });
    if (result.result && result.result.value !== undefined) {
      return result.result.value;
    }
    return JSON.stringify(result);
  }

  const targetTable = process.argv[2] || 'Pool #3';
  console.log('Looking for table:', targetTable);

  // Click on a specific table
  const clickResult = await evaluate(`
    (function() {
      var allDivs = document.querySelectorAll('.select-none');
      var found = null;
      for (var i = 0; i < allDivs.length; i++) {
        var text = allDivs[i].textContent.trim();
        if (text.indexOf('${targetTable}') === 0) {
          found = { text: text, tag: allDivs[i].tagName };
          // Click the element
          allDivs[i].click();
          break;
        }
      }
      if (!found) {
        // List all table-like elements
        var tables = [];
        allDivs.forEach(function(d) {
          var t = d.textContent.trim();
          if (t.indexOf('Pool') >= 0 || t.indexOf('Snooker') >= 0 || t.indexOf('VIP') >= 0) {
            tables.push(t.substring(0, 30));
          }
        });
        return JSON.stringify({ error: 'Table not found', availableTables: tables });
      }
      return JSON.stringify({ clicked: found });
    })()
  `);
  console.log('Click result:', clickResult);

  // Wait for modal/panel to appear
  await new Promise(r => setTimeout(r, 1500));

  // Check what appeared after clicking
  const afterClick = await evaluate(`
    (function() {
      // Check for modals or panels
      var modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="panel"], [class*="slide"]');
      var results = [];
      modals.forEach(function(m) {
        results.push({
          tag: m.tagName,
          class: m.className.substring(0, 80),
          visible: m.offsetWidth > 0,
          text: m.textContent.substring(0, 200)
        });
      });

      // Also check for any new buttons that appeared (like "Start Session")
      var buttons = document.querySelectorAll('button');
      var newButtons = [];
      buttons.forEach(function(btn) {
        var text = btn.textContent.trim();
        if (text.indexOf('Start') >= 0 || text.indexOf('Session') >= 0 || text.indexOf('End') >= 0 ||
            text.indexOf('Pause') >= 0 || text.indexOf('Resume') >= 0 || text.indexOf('Add') >= 0 ||
            text.indexOf('Pay') >= 0 || text.indexOf('Transfer') >= 0 || text.indexOf('Close') >= 0) {
          newButtons.push({
            text: text,
            class: btn.className.substring(0, 60),
            disabled: btn.disabled,
            visible: btn.offsetWidth > 0
          });
        }
      });

      return JSON.stringify({
        modals: results.length,
        modalDetails: results.slice(0, 3),
        actionButtons: newButtons
      });
    })()
  `);
  console.log('After click:', afterClick);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
