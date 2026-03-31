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
      const timer = setTimeout(() => reject(new Error('timeout')), 15000);
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

  // Check floor overview from IPC (fresh, not from cache)
  console.log('=== Floor Overview (IPC) ===');
  const overview = await evaluate(`
    (async function() {
      try {
        var data = await window.electronAPI.billiard.getFloorOverview();
        var tables = data.tables || [];
        var active = tables.filter(function(t) { return t.status !== 'free'; });
        var free = tables.filter(function(t) { return t.status === 'free'; });
        return JSON.stringify({
          total: tables.length,
          free: free.length,
          active: active.length,
          activeTables: active.map(function(t) {
            return {
              name: t.resource.name,
              status: t.status,
              sessionId: t.session ? t.session.id : null,
              guests: t.session ? t.session.guestCount : 0,
              startedAt: t.session ? t.session.startedAt : null
            };
          }),
          fromCache: data._fromCache
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(overview);

  // Check the UI rendered stats
  console.log('\n=== UI Stats Bar ===');
  const stats = await evaluate(`
    (function() {
      // The stats are in the header area, look for numbers
      var allText = document.body.textContent;
      var freeMatch = allText.match(/(\\d+)\\s*Free/);
      var activeMatch = allText.match(/(\\d+)\\s*Active/);
      var pausedMatch = allText.match(/(\\d+)\\s*Paused/);
      var guestsMatch = allText.match(/(\\d+)\\s*Guests/);

      // Find Pool #3 specifically
      var divs = document.querySelectorAll('.select-none');
      var pool3 = null;
      divs.forEach(function(d) {
        if (d.textContent.indexOf('Pool #3') >= 0) {
          var bg = getComputedStyle(d.querySelector('[class*="rounded"]') || d).backgroundColor;
          pool3 = {
            text: d.textContent.substring(0, 80),
            bgColor: bg
          };
        }
      });

      return JSON.stringify({
        uiFree: freeMatch ? freeMatch[1] : 'unknown',
        uiActive: activeMatch ? activeMatch[1] : 'unknown',
        uiPaused: pausedMatch ? pausedMatch[1] : 'unknown',
        uiGuests: guestsMatch ? guestsMatch[1] : 'unknown',
        pool3: pool3
      });
    })()
  `);
  console.log(stats);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
