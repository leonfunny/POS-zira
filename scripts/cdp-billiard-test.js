const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');

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
    if (result.result && result.result.value) {
      return result.result.value;
    }
    if (result.result && result.result.description) {
      return result.result.description;
    }
    return JSON.stringify(result.result);
  }

  // Step 1: Check billiard floor plan content
  console.log('\n=== STEP 1: Check Billiard Floor Plan ===');
  const floorPlan = await evaluate(`
    (function() {
      var tables = document.querySelectorAll('[data-table-id], [data-resource-id]');
      if (tables.length > 0) {
        return JSON.stringify({
          type: 'data-attr-tables',
          count: tables.length,
          ids: Array.from(tables).slice(0, 5).map(function(t) {
            return { id: t.dataset.tableId || t.dataset.resourceId, text: t.textContent.trim().substring(0, 50) };
          })
        });
      }
      // Try to find table cards by text content
      var allElements = document.querySelectorAll('div, button');
      var tableElements = [];
      allElements.forEach(function(el) {
        var text = el.textContent.trim();
        if ((text.indexOf('Pool') >= 0 || text.indexOf('Snooker') >= 0 || text.indexOf('VIP') >= 0) && text.length < 100) {
          if (el.querySelector && !el.querySelector('[class*="sidebar"]')) {
            tableElements.push({
              tag: el.tagName,
              class: el.className.substring(0, 80),
              text: text.substring(0, 60),
              hasClick: typeof el.onclick === 'function' || el.getAttribute('role') === 'button'
            });
          }
        }
      });
      return JSON.stringify({
        type: 'text-search',
        found: tableElements.length,
        samples: tableElements.slice(0, 10)
      });
    })()
  `);
  console.log('Floor plan:', floorPlan);

  // Step 2: Check the full rendered content of the main area
  console.log('\n=== STEP 2: Main Content Area ===');
  const mainContent = await evaluate(`
    (function() {
      var sidebar = document.querySelector('.sidebar');
      var main = sidebar ? sidebar.nextElementSibling : null;
      if (!main) {
        // Try finding the content area by flex structure
        var outer = document.getElementById('root').children[0];
        var children = outer ? outer.children : [];
        var info = [];
        for (var i = 0; i < children.length; i++) {
          info.push({
            tag: children[i].tagName,
            class: children[i].className.substring(0, 80),
            width: children[i].offsetWidth,
            height: children[i].offsetHeight,
            childCount: children[i].children.length,
            text: children[i].textContent.substring(0, 100)
          });
        }
        return JSON.stringify({ type: 'outer-children', count: info.length, children: info });
      }
      return JSON.stringify({
        type: 'main-area',
        tag: main.tagName,
        class: main.className.substring(0, 80),
        width: main.offsetWidth,
        height: main.offsetHeight,
        innerHTML: main.innerHTML.substring(0, 500)
      });
    })()
  `);
  console.log('Main content:', mainContent);

  // Step 3: Look for Start Session button or similar billiard controls
  console.log('\n=== STEP 3: Billiard Controls ===');
  const controls = await evaluate(`
    (function() {
      var buttons = document.querySelectorAll('button');
      var billiardButtons = [];
      buttons.forEach(function(btn) {
        var text = btn.textContent.trim();
        if (text.length > 0 && text.length < 50) {
          billiardButtons.push({
            text: text,
            class: btn.className.substring(0, 60),
            disabled: btn.disabled,
            visible: btn.offsetWidth > 0
          });
        }
      });
      return JSON.stringify({
        totalButtons: buttons.length,
        namedButtons: billiardButtons.length,
        buttons: billiardButtons.slice(0, 20)
      });
    })()
  `);
  console.log('Controls:', controls);

  client.close();
}

run().catch(e => console.error('Error:', e.message)).finally(() => setTimeout(() => process.exit(0), 500));
