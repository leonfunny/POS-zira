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
  if (!page) { console.log('No page'); return; }
  const client = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => client.on('open', r));
  let id = 0;
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const myId = ++id;
      const timer = setTimeout(() => reject(new Error('timeout')), 10000);
      const handler = (raw) => { const msg = JSON.parse(raw.toString()); if (msg.id === myId) { clearTimeout(timer); client.removeListener('message', handler); resolve(msg); } };
      client.on('message', handler);
      client.send(JSON.stringify({ id: myId, method, params: params || {} }));
    });
  }
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const inner = result.result && result.result.result;
    if (inner && inner.value !== undefined) return inner.value;
    return JSON.stringify(result);
  }

  const ent = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.entitlements.get();
        return JSON.stringify(result, null, 2);
      } catch(err) {
        return JSON.stringify({ error: err.message });
      }
    })()
  `);
  console.log('Entitlements:', ent);
  client.close();
}
run().catch(e => console.error(e.message)).finally(() => setTimeout(() => process.exit(0), 500));
