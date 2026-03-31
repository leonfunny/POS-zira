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
    if (inner && inner.value !== undefined) {
      return inner.value;
    }
    if (inner && inner.description) {
      return inner.description;
    }
    return JSON.stringify(result);
  }

  const action = process.argv[2] || 'list';

  if (action === 'list') {
    // List all tables and their status
    console.log('=== Listing Tables ===');
    const tables = await evaluate(`
      (async function() {
        try {
          var data = await window.electronAPI.billiard.getFloorOverview();
          var tables = data.tables || [];
          return JSON.stringify(tables.map(function(t) {
            return {
              id: t.resource.id,
              name: t.resource.name,
              status: t.status,
              sessionId: t.session ? t.session.id : null,
              guestCount: t.session ? t.session.guestCount : 0,
              items: t.session ? (t.session.items || []).length : 0
            };
          }));
        } catch(err) {
          return JSON.stringify({ error: err.message });
        }
      })()
    `);
    console.log(JSON.stringify(JSON.parse(tables), null, 2));
  }

  else if (action === 'start') {
    const resourceId = process.argv[3];
    const guestCount = parseInt(process.argv[4] || '1');
    if (!resourceId) { console.log('Usage: start <resourceId> [guestCount]'); client.close(); return; }

    console.log('=== Starting Session ===');
    console.log('Resource:', resourceId, 'Guests:', guestCount);

    const result = await evaluate(`
      (async function() {
        try {
          var result = await window.electronAPI.billiard.mutate(
            'start_session',
            'POST',
            '/billiard/sessions',
            { resourceId: '${resourceId}', guestCount: ${guestCount} }
          );
          return JSON.stringify({ success: true, data: result });
        } catch(err) {
          return JSON.stringify({ success: false, error: err.message || String(err) });
        }
      })()
    `);
    console.log('Result:', result);
  }

  else if (action === 'end') {
    const sessionId = process.argv[3];
    if (!sessionId) { console.log('Usage: end <sessionId>'); client.close(); return; }

    console.log('=== Ending Session ===');
    const result = await evaluate(`
      (async function() {
        try {
          var result = await window.electronAPI.billiard.mutate(
            'end_session',
            'PATCH',
            '/billiard/sessions/${sessionId}/end',
            {}
          );
          return JSON.stringify({ success: true, data: result });
        } catch(err) {
          return JSON.stringify({ success: false, error: err.message || String(err) });
        }
      })()
    `);
    console.log('Result:', result);
  }

  else if (action === 'add-item') {
    const sessionId = process.argv[3];
    const name = process.argv[4] || 'Heineken';
    const qty = parseInt(process.argv[5] || '1');
    const price = parseInt(process.argv[6] || '1400');

    if (!sessionId) { console.log('Usage: add-item <sessionId> [name] [qty] [priceGrosze]'); client.close(); return; }

    console.log('=== Adding Item ===');
    console.log('Session:', sessionId, 'Item:', name, 'Qty:', qty, 'Price:', price);

    const result = await evaluate(`
      (async function() {
        try {
          var result = await window.electronAPI.billiard.mutate(
            'add_item',
            'POST',
            '/billiard/sessions/${sessionId}/items',
            { name: '${name}', quantity: ${qty}, unitPrice: ${price} }
          );
          return JSON.stringify({ success: true, data: result });
        } catch(err) {
          return JSON.stringify({ success: false, error: err.message || String(err) });
        }
      })()
    `);
    console.log('Result:', result);
  }

  else if (action === 'pay') {
    const sessionId = process.argv[3];
    if (!sessionId) { console.log('Usage: pay <sessionId>'); client.close(); return; }

    console.log('=== Processing Payment ===');
    const result = await evaluate(`
      (async function() {
        try {
          var result = await window.electronAPI.billiard.mutate(
            'process_payment',
            'POST',
            '/billiard/sessions/${sessionId}/payment',
            { paymentMethod: 'CASH' }
          );
          return JSON.stringify({ success: true, data: result });
        } catch(err) {
          return JSON.stringify({ success: false, error: err.message || String(err) });
        }
      })()
    `);
    console.log('Result:', result);
  }

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
