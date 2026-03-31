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

  // Check for any remaining active sessions
  console.log('=== Active Sessions in Dashboard API ===');
  const active = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.apiCall('GET', '/billiard/dashboard');
        var active = result.filter(function(t) { return t.session !== null; });
        return JSON.stringify(active.map(function(t) {
          return {
            table: t.resource.name,
            sessionId: t.session.id,
            status: t.session.status,
            startedAt: t.session.startedAt,
            paymentStatus: t.session.paymentStatus
          };
        }));
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(active);

  // Check local cache
  console.log('\n=== Local Cache Active Sessions ===');
  const local = await evaluate(`
    (async function() {
      try {
        var data = await window.electronAPI.billiard.getFloorOverview();
        var tables = data.tables || [];
        var active = tables.filter(function(t) { return t.status !== 'free'; });
        return JSON.stringify(active.map(function(t) {
          return {
            table: t.resource.name,
            status: t.status,
            sessionId: t.session ? t.session.id : null,
            sessionStatus: t.session ? t.session.status : null
          };
        }));
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(local);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
