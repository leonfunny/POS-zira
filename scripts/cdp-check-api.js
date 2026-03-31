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
    const inner = result.result && result.result.result;
    if (inner && inner.value !== undefined) return inner.value;
    if (inner && inner.description) return inner.description;
    return JSON.stringify(result);
  }

  // Check billiard methods
  const billiardKeys = await evaluate('JSON.stringify(Object.keys(window.electronAPI.billiard || {}))');
  console.log('billiard methods:', billiardKeys);

  // Check top-level electronAPI keys
  const apiKeys = await evaluate('JSON.stringify(Object.keys(window.electronAPI))');
  console.log('electronAPI keys:', apiKeys);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
