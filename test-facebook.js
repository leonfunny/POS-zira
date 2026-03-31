const { chromium } = require('rebrowser-playwright-core');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

async function run() {
  console.log('--- TEST FACEBOOK AUTOMATION START ---');

  // 1. Kill Chrome
  console.log('1. Killing existing Chrome processes...');
  await new Promise(resolve => {
    exec('taskkill /F /IM chrome.exe', (err) => {
      if (err) console.log('   (No Chrome process found or kill failed - OK)');
      else console.log('   Chrome killed.');
      resolve();
    });
  });
  console.log('   Waiting 2s for cleanup...');
  await new Promise(r => setTimeout(r, 2000));

  // 2. Find Chrome Path (Robust)
  console.log('2. Finding Chrome...');
  const chromePaths = [
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];

  let chromePath = '';
  for (const p of chromePaths) {
    if (p && fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }

  if (!chromePath) {
    console.error('❌ Chrome not found in standard locations!');
    return;
  }
  console.log(`   Found Chrome at: ${chromePath}`);

  // 3. Launch Chrome
  console.log('3. Launching Chrome with User Profile...');
  const userDataDir = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
  
  // Arguments matching Zira AI's logic
  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir="${userDataDir}"`, // Corrected escaping for quotes within template literal
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--profile-directory="Default"', // Default profile
    'https://facebook.com'
  ];

  const cmd = `"${chromePath}" ${args.join(' ')}`;
  console.log(`   Command: ${cmd}`);
  
  // Spawn Chrome detached
  const chromeProcess = exec(cmd);
  chromeProcess.unref();

  // 4. Connect via CDP
  console.log('4. Connecting to Chrome CDP (http://127.0.0.1:9222)...');
  
  // Poll for connection
  let browser = null;
  for (let i = 0; i < 15; i++) {
    try {
      await new Promise(r => setTimeout(r, 1000));
      process.stdout.write(`   Attempt ${i+1}/15... `);
      browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
      console.log('✅ Connected successfully!');
      break;
    } catch (e) {
      console.log(`Retrying...`);
    }
  }

  if (!browser) {
    console.error('\n❌ Could not connect to Chrome after 15 attempts.');
    console.error('   Please check if Chrome opened and if port 9222 is active.');
    return;
  }

  try {
    // 5. Verify Page
    const contexts = browser.contexts();
    // Get the first page (which should be Facebook)
    const page = contexts[0].pages()[0]; 

    console.log('5. Verifying Page...');
    // Wait for page object to be ready
    if (!page) {
        console.log('   ⚠️ No page found yet, waiting...');
        await new Promise(r => setTimeout(r, 2000));
    }
    
    const targetPage = contexts[0].pages()[0];
    console.log(`   URL: ${targetPage.url()}`);
    console.log(`   Title: ${await targetPage.title()}`);

    // Wait for content
    console.log('6. Waiting for Facebook feed...');
    try {
        await targetPage.waitForSelector('[role="article"]', { timeout: 10000 });
    } catch (e) {
        console.log('   (Timeout waiting for [role="article"], trying to read anyway...)');
    }

    // Read Posts
    console.log('7. Reading first 3 posts...');
    const posts = await targetPage.evaluate(() => {
      // Try multiple selectors
      const articles = document.querySelectorAll('[role="article"], [data-ad-preview], .userContentWrapper, .x1yztbdb');
      const results = [];
      for (let i = 0; i < Math.min(3, articles.length); i++) {
        const text = articles[i].innerText || articles[i].textContent || '';
        // Extract author if possible
        const authorEl = articles[i].querySelector('strong, h3, h4, span[style*="font-weight: 600"]');
        const author = authorEl ? authorEl.innerText : 'Unknown';
        
        results.push({
          index: i,
          author: author,
          preview: text.substring(0, 150).replace(/\n/g, ' ') + '...'
        });
      }
      return results;
    });

    console.log('\n--- RESULTS ---');
    if (posts.length > 0) {
      console.log(`✅ Found ${posts.length} posts:`);
      posts.forEach(p => console.log(`   [${p.index}] ${p.author}: ${p.preview}`));
    } else {
      console.log('⚠️ No posts found. Login might be required or selectors changed.');
      console.log('   Current Page Content Sample:');
      const bodyText = await targetPage.evaluate(() => document.body.innerText.substring(0, 200));
      console.log(`   "${bodyText}..."`);
    }

    console.log('----------------');
    console.log('Test completed.');
    // Don't close browser so user can see it
    await browser.disconnect(); 

  } catch (e) {
    console.error('❌ Script error:', e);
  }
}

run();