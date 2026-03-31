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

  // Check if the billiard sync module has any refresh/sync methods exposed
  const methods = await evaluate(`
    (function() {
      // Check what methods the renderer has to trigger refresh
      var api = window.electronAPI.billiard;
      return JSON.stringify(Object.keys(api));
    })()
  `);
  console.log('Available methods:', methods);

  // Try to get session directly (this goes to backend API)
  console.log('\n=== Get Active Session via getSession ===');
  const session = await evaluate(`
    (async function() {
      try {
        var session = await window.electronAPI.billiard.getSession('0bf274d8-6174-4791-8d92-51e0a8a61c8a');
        return JSON.stringify({
          id: session.id,
          status: session.status,
          resourceId: session.resourceId,
          guestCount: session.guestCount,
          startedAt: session.startedAt,
          items: session.items ? session.items.length : 0
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Session:', session);

  // Check the sync status
  console.log('\n=== Sync Status ===');
  const syncStatus = await evaluate(`
    (async function() {
      try {
        var status = await window.electronAPI.billiard.getSyncStatus();
        return JSON.stringify(status);
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Sync:', syncStatus);

  // Now end this session and clean up
  console.log('\n=== End Active Session on Pool #3 ===');
  const endResult = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.billiard.mutate(
          'end_session',
          'PATCH',
          '/billiard/sessions/0bf274d8-6174-4791-8d92-51e0a8a61c8a/end',
          {}
        );
        return JSON.stringify({
          id: result.id,
          status: result.status,
          duration: result.durationMinutes,
          timeCharge: result.timeCharge,
          fnbCharge: result.fnbCharge,
          totalCharge: result.totalCharge,
          paymentStatus: result.paymentStatus
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('End result:', endResult);

  // Wait for refresh
  await new Promise(r => setTimeout(r, 3000));

  // Check floor overview again after refresh
  console.log('\n=== Floor Overview after end + 3s wait ===');
  const overview = await evaluate(`
    (async function() {
      try {
        var data = await window.electronAPI.billiard.getFloorOverview();
        var tables = data.tables || [];
        var active = tables.filter(function(t) { return t.status !== 'free'; });
        return JSON.stringify({
          total: tables.length,
          free: tables.length - active.length,
          active: active.length,
          activeTables: active.map(function(t) {
            return { name: t.resource.name, status: t.status };
          }),
          fromCache: data._fromCache
        });
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Overview:', overview);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
