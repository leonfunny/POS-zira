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

  const js = `
    (function() {
      var root = document.getElementById('root');
      var outer = root.children[0];
      var sidebar = document.querySelector('.sidebar');
      var items = document.querySelectorAll('.sidebar-item');
      var itemTexts = [];
      items.forEach(function(e) { itemTexts.push(e.textContent.trim()); });

      return JSON.stringify({
        outerClass: outer ? outer.className : 'no-outer',
        outerBg: outer ? getComputedStyle(outer).backgroundColor : 'none',
        sidebarBg: sidebar ? getComputedStyle(sidebar).backgroundColor : 'none',
        sidebarWidth: sidebar ? sidebar.offsetWidth : 0,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        contentWidth: outer ? outer.offsetWidth : 0,
        contentHeight: outer ? outer.offsetHeight : 0,
        sidebarItems: itemTexts.join(', '),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        consoleErrors: window.__consoleErrors || [],
      });
    })()
  `;

  const result = await send('Runtime.evaluate', {
    expression: js,
    returnByValue: true
  });

  if (result.result && result.result.value) {
    try {
      console.log(JSON.parse(result.result.value));
    } catch(e) {
      console.log('Raw value:', result.result.value);
    }
  } else {
    console.log('Result:', JSON.stringify(result, null, 2));
  }
  client.close();
}

run().catch(e => console.error(e.message)).finally(() => setTimeout(() => process.exit(0), 500));
