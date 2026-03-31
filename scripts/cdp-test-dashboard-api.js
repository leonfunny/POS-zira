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

  // Try to call the dashboard API via the app's API client to see what it returns
  console.log('=== Test Dashboard API via IPC apiCall ===');
  const dashboardResult = await evaluate(`
    (async function() {
      try {
        var result = await window.electronAPI.apiCall('GET', '/billiard/dashboard');
        if (!result) return JSON.stringify({ error: 'null response' });
        var isArray = Array.isArray(result);
        var keys = isArray ? ['array'] : Object.keys(result);
        var len = isArray ? result.length : 'N/A';
        var sample = JSON.stringify(result).substring(0, 800);
        return JSON.stringify({ isArray: isArray, keys: keys, length: len, sample: sample });
      } catch(err) {
        return JSON.stringify({ error: err.message, stack: (err.stack || '').substring(0, 300) });
      }
    })()
  `);
  console.log('Dashboard API result:', dashboardResult);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
