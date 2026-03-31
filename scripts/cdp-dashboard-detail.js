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

  // Start a new session, then immediately check dashboard API
  console.log('=== Step 1: Start Session on Pool #7 ===');
  const startResult = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.billiard.mutate(
          'start_session', 'POST', '/billiard/sessions',
          { resourceId: 'ab160555-a1ce-423f-abfc-83bbafc8a22a', guestCount: 2 }
        );
        return JSON.stringify({ id: result.id, status: result.status, resource: result.resourceId });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Start:', startResult);

  // Wait 2 seconds for the background dashboard refresh
  await new Promise(r => setTimeout(r, 2000));

  // Check dashboard API directly
  console.log('\n=== Step 2: Check Dashboard API (after 2s) ===');
  const dashboard = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.apiCall('GET', '/billiard/dashboard');
        if (!Array.isArray(result)) return JSON.stringify({ error: 'not array', type: typeof result });
        var active = result.filter(function(t) { return t.session !== null; });
        return JSON.stringify({
          total: result.length,
          withSession: active.length,
          activeTables: active.map(function(t) {
            return {
              name: t.resource.name,
              status: t.status,
              sessionId: t.session ? t.session.id : null,
              sessionStatus: t.session ? t.session.status : null
            };
          })
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Dashboard:', dashboard);

  // Check floor overview (local cache)
  console.log('\n=== Step 3: Floor Overview (local cache) ===');
  const overview = await evaluate(`
    (async function() {
      try {
        var data = await window.electronAPI.billiard.getFloorOverview();
        var tables = data.tables || [];
        var active = tables.filter(function(t) { return t.status !== 'free'; });
        return JSON.stringify({
          total: tables.length,
          active: active.length,
          fromCache: data._fromCache,
          activeTables: active.map(function(t) {
            return { name: t.resource.name, status: t.status };
          })
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Local cache:', overview);

  // End session to clean up
  const parsed = JSON.parse(startResult);
  if (parsed.id) {
    console.log('\n=== Cleanup: End session ===');
    const endResult = await evaluate(`
      (async function() {
        try {
          await window.electronAPI.billiard.mutate('end_session', 'PATCH', '/billiard/sessions/${parsed.id}/end', {});
          await window.electronAPI.billiard.mutate('process_payment', 'POST', '/billiard/sessions/${parsed.id}/payment', { paymentMethod: 'CASH' });
          return JSON.stringify({ cleaned: true });
        } catch(err) {
          return JSON.stringify({ error: err.message });
        }
      })()
    `);
    console.log('Cleanup:', endResult);
  }

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
