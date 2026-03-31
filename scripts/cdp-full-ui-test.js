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

  // ── Step 1: Start session ──
  console.log('=== Step 1: Start Session on Pool #5 (2 guests) ===');
  const startResult = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.billiard.mutate(
          'start_session', 'POST', '/billiard/sessions',
          { resourceId: '18772d17-f915-433f-b639-7f62914ca9ac', guestCount: 2 }
        );
        return JSON.stringify({ id: result.id, status: result.status, hourlyRate: result.hourlyRate });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(startResult);
  const sessionId = JSON.parse(startResult).id;

  // Wait for dashboard refresh
  await new Promise(r => setTimeout(r, 3000));

  // ── Step 2: Check UI stats ──
  console.log('\n=== Step 2: Check UI Stats Bar ===');
  const stats = await evaluate(`
    (function() {
      var text = document.body.textContent;
      var free = text.match(/(\\d+)Free/);
      var active = text.match(/(\\d+)Active/);
      var paused = text.match(/(\\d+)Paused/);
      var guests = text.match(/(\\d+)Guests/);

      // Check Pool #5 table background color
      var divs = document.querySelectorAll('.select-none');
      var pool5 = null;
      divs.forEach(function(d) {
        if (d.textContent.indexOf('Pool #5') >= 0 && d.textContent.length < 100) {
          var inner = d.querySelector('[class*="rounded"]');
          pool5 = {
            text: d.textContent.substring(0, 80),
            bgColor: inner ? getComputedStyle(inner).backgroundColor : 'unknown',
            classes: inner ? inner.className.substring(0, 120) : 'unknown'
          };
        }
      });

      return JSON.stringify({
        free: free ? free[1] : '?',
        active: active ? active[1] : '?',
        paused: paused ? paused[1] : '?',
        guests: guests ? guests[1] : '?',
        pool5: pool5
      });
    })()
  `);
  console.log(stats);

  // ── Step 3: Add items ──
  console.log('\n=== Step 3: Add F&B Items ===');
  const addResult = await evaluate(`
    (async function() {
      try {
        var r1 = await window.electronAPI.billiard.mutate(
          'add_item', 'POST', '/billiard/sessions/${sessionId}/items',
          { name: 'Piwo Tyskie', quantity: 3, unitPrice: 1200 }
        );
        var r2 = await window.electronAPI.billiard.mutate(
          'add_item', 'POST', '/billiard/sessions/${sessionId}/items',
          { name: 'Nachos', quantity: 1, unitPrice: 2500 }
        );
        return JSON.stringify({
          item1: { name: r1.name, qty: r1.quantity, total: r1.totalPrice },
          item2: { name: r2.name, qty: r2.quantity, total: r2.totalPrice }
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(addResult);

  // ── Step 4: Check session detail ──
  console.log('\n=== Step 4: Session Detail ===');
  const detail = await evaluate(`
    (async function() {
      try {
        var s = await window.electronAPI.billiard.getSession('${sessionId}');
        return JSON.stringify({
          id: s.id, status: s.status, guests: s.guestCount,
          items: (s.items || []).map(function(i) { return i.name + ' x' + i.quantity; }),
          startedAt: s.startedAt
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(detail);

  // ── Step 5: End session ──
  console.log('\n=== Step 5: End Session ===');
  const endResult = await evaluate(`
    (async function() {
      try {
        var r = await window.electronAPI.billiard.mutate(
          'end_session', 'PATCH', '/billiard/sessions/${sessionId}/end', {}
        );
        return JSON.stringify({
          status: r.status,
          duration: r.durationMinutes + ' min',
          timeCharge: r.timeCharge + ' PLN',
          fnbCharge: (r.fnbCharge / 100) + ' PLN',
          totalCharge: r.totalCharge + ' PLN',
          paymentStatus: r.paymentStatus
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(endResult);

  // ── Step 6: Process payment ──
  console.log('\n=== Step 6: Process Payment (CASH) ===');
  const payResult = await evaluate(`
    (async function() {
      try {
        var r = await window.electronAPI.billiard.mutate(
          'process_payment', 'POST', '/billiard/sessions/${sessionId}/payment',
          { paymentMethod: 'CASH' }
        );
        return JSON.stringify({
          paymentStatus: r.paymentStatus,
          paymentMethod: r.paymentMethod,
          totalCharge: r.totalCharge
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(payResult);

  // Wait for dashboard refresh after payment
  await new Promise(r => setTimeout(r, 3000));

  // ── Step 7: Final UI check ──
  console.log('\n=== Step 7: Final UI State ===');
  const finalStats = await evaluate(`
    (function() {
      var text = document.body.textContent;
      var free = text.match(/(\\d+)Free/);
      var active = text.match(/(\\d+)Active/);
      return JSON.stringify({
        free: free ? free[1] : '?',
        active: active ? active[1] : '?'
      });
    })()
  `);
  console.log(finalStats);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
