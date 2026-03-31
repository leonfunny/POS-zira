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

  const targetTable = process.argv[2] || 'Pool #5';
  console.log('Target:', targetTable);

  // Find the table element coordinates and dispatch proper mouse event
  const coords = await evaluate(`
    (function() {
      var allDivs = document.querySelectorAll('.select-none');
      for (var i = 0; i < allDivs.length; i++) {
        var text = allDivs[i].textContent.trim();
        if (text.indexOf('${targetTable}') === 0) {
          var rect = allDivs[i].getBoundingClientRect();
          var cx = rect.left + rect.width / 2;
          var cy = rect.top + rect.height / 2;

          // Dispatch full mouse event sequence
          var events = ['mousedown', 'mouseup', 'click'];
          events.forEach(function(type) {
            var evt = new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: cx,
              clientY: cy,
              button: 0,
            });
            allDivs[i].dispatchEvent(evt);
          });

          return JSON.stringify({
            found: text,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            clickAt: { x: cx, y: cy }
          });
        }
      }
      return JSON.stringify({ error: 'not found' });
    })()
  `);
  console.log('Coords + click:', coords);

  // Wait for popover
  await new Promise(r => setTimeout(r, 1000));

  // Check for popover/action buttons
  const afterClick = await evaluate(`
    (function() {
      // Look for the TableActionPopover
      var allBtns = document.querySelectorAll('button');
      var actionBtns = [];
      allBtns.forEach(function(btn) {
        var text = btn.textContent.trim();
        if (text.indexOf('Start') >= 0 || text.indexOf('Pause') >= 0 || text.indexOf('Resume') >= 0 ||
            text.indexOf('End') >= 0 || text.indexOf('Add Item') >= 0 || text.indexOf('Pay') >= 0 ||
            text.indexOf('Transfer') >= 0 || text.indexOf('Detail') >= 0 || text.indexOf('Quick') >= 0) {
          actionBtns.push({
            text: text.substring(0, 40),
            visible: btn.offsetWidth > 0,
            disabled: btn.disabled
          });
        }
      });

      // Check for any visible popover/tooltip/overlay
      var overlays = document.querySelectorAll('[class*="popover"], [class*="Popover"], [class*="absolute"][class*="z-"]');
      var visibleOverlays = [];
      overlays.forEach(function(o) {
        if (o.offsetWidth > 0 && o.textContent.trim().length > 0) {
          visibleOverlays.push({
            class: o.className.substring(0, 80),
            text: o.textContent.substring(0, 100)
          });
        }
      });

      return JSON.stringify({
        actionButtons: actionBtns,
        overlays: visibleOverlays.slice(0, 5)
      });
    })()
  `);
  console.log('After click:', afterClick);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
