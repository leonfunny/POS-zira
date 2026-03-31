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
      const timer = setTimeout(() => reject(new Error('timeout')), 5000);
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

  // Dispatch resize event to trigger layout recalculation
  const result = await send('Runtime.evaluate', {
    expression: 'window.dispatchEvent(new Event("resize")); "Width before: " + window.innerWidth + " Height: " + window.innerHeight',
    returnByValue: true
  });
  console.log('Before resize:', result.result.value);

  // Try to resize the viewport via Emulation
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1040,
    deviceScaleFactor: 1,
    mobile: false,
  });

  console.log('Set viewport to 1920x1040');

  // Check new size
  const result2 = await send('Runtime.evaluate', {
    expression: '"Width after: " + window.innerWidth + " Height: " + window.innerHeight',
    returnByValue: true
  });
  console.log('After resize:', result2.result.value);

  client.close();
}

run().catch(e => console.error(e.message)).finally(() => setTimeout(() => process.exit(0), 500));
