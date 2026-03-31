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
    if (inner && inner.value !== undefined) return inner.value;
    if (inner && inner.description) return inner.description;
    return JSON.stringify(result);
  }

  const sessionId = process.argv[2];
  if (!sessionId) {
    console.log('Usage: node cdp-session-detail.js <sessionId>');
    client.close();
    return;
  }

  // Get session detail via IPC
  console.log('=== Session Detail ===');
  const detail = await evaluate(`
    (async function() {
      try {
        var session = await window.electronAPI.billiard.getSession('${sessionId}');
        return JSON.stringify(session, null, 2);
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log(detail);

  // Also check sync status
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
  console.log(syncStatus);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
