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
    // CDP wraps: { id, result: { result: { type, value } } }
    const inner = result.result && result.result.result;
    if (inner && inner.value !== undefined) {
      return inner.value;
    }
    return JSON.stringify(result);
  }

  const targetTable = process.argv[2] || 'Pool #5';
  console.log('Target:', targetTable);

  // Get coordinates of the target table
  const coordsStr = await evaluate(`
    (function() {
      var allDivs = document.querySelectorAll('.select-none');
      for (var i = 0; i < allDivs.length; i++) {
        var text = allDivs[i].textContent.trim();
        if (text.indexOf('${targetTable}') === 0) {
          var rect = allDivs[i].getBoundingClientRect();
          return JSON.stringify({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            text: text
          });
        }
      }
      return JSON.stringify({ error: 'not found' });
    })()
  `);

  let coords;
  try {
    coords = JSON.parse(coordsStr);
    // If it's wrapped in CDP result structure, unwrap
    if (coords.id && coords.result) {
      coords = JSON.parse(coords.result.value);
    }
  } catch(e) {
    console.error('Parse error:', e.message, 'raw:', coordsStr);
    client.close();
    return;
  }
  console.log('Found table at:', coords);

  if (coords.error) {
    console.log('Table not found');
    client.close();
    return;
  }

  // Use CDP Input domain for native mouse events
  console.log('Dispatching native mouse events at', coords.x, coords.y);

  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: coords.x,
    y: coords.y,
    button: 'left',
    clickCount: 1,
  });

  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: coords.x,
    y: coords.y,
    button: 'left',
    clickCount: 1,
  });

  console.log('Mouse events dispatched');

  // Wait for popover to appear
  await new Promise(r => setTimeout(r, 1500));

  // Check what appeared
  const afterClick = await evaluate(`
    (function() {
      var allBtns = document.querySelectorAll('button');
      var actionBtns = [];
      allBtns.forEach(function(btn) {
        var text = btn.textContent.trim();
        if (text.length > 0 && text.length < 60 && btn.offsetWidth > 0) {
          actionBtns.push(text);
        }
      });

      // Check ALL visible elements with z-index > 40 (popover level)
      var highZ = [];
      document.querySelectorAll('*').forEach(function(el) {
        var z = parseInt(getComputedStyle(el).zIndex);
        if (z >= 40 && el.offsetWidth > 0 && el.textContent.trim().length > 0) {
          highZ.push({
            tag: el.tagName,
            z: z,
            class: el.className.substring(0, 60),
            text: el.textContent.substring(0, 80)
          });
        }
      });

      return JSON.stringify({
        allButtons: actionBtns,
        highZElements: highZ.slice(0, 10)
      });
    })()
  `);
  console.log('After click:', afterClick);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
