/**
 * Facebook Stealth Scraper - Anti-Bot Detection Bypass
 *
 * Bypasses Facebook's 4 layers of bot detection:
 * 1. Browser Fingerprinting
 * 2. Behavioral Analysis
 * 3. Network Analysis
 * 4. Account Signals
 *
 * Usage: npm run scrape:fb:stealth
 */

const { chromium } = require('rebrowser-playwright-core');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  cdpUrl: 'http://127.0.0.1:9222',
  postsToScrape: 10,
  outputDir: './facebook-scrapes',
  useLLMSummary: true,
  openaiModel: 'gpt-4o-mini',

  // Anti-detection timing (human-like)
  behavior: {
    minScrollDelay: 800,
    maxScrollDelay: 2500,
    minScrollAmount: 300,
    maxScrollAmount: 700,
    mouseMovementEnabled: true,
    randomPausesEnabled: true,
    pauseChance: 0.15,          // 15% chance to pause
    minPauseDuration: 2000,
    maxPauseDuration: 8000,
    maxScrollAttempts: 30,
  },
};

// ============================================================================
// HUMAN BEHAVIOR SIMULATION
// ============================================================================

class HumanBehavior {
  /**
   * Random number between min and max
   */
  static random(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Random float for more natural timing
   */
  static randomFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  /**
   * Human-like delay with variance
   */
  static async humanDelay(baseMs, variance = 0.3) {
    const delay = baseMs * (1 + (Math.random() - 0.5) * variance * 2);
    await sleep(delay);
  }

  /**
   * Generate bezier curve points for natural mouse movement
   */
  static generateBezierPath(start, end, steps = 20) {
    const points = [];

    // Control points for bezier curve (adds natural curve)
    const cp1 = {
      x: start.x + (end.x - start.x) * 0.25 + this.random(-50, 50),
      y: start.y + (end.y - start.y) * 0.1 + this.random(-30, 30),
    };
    const cp2 = {
      x: start.x + (end.x - start.x) * 0.75 + this.random(-50, 50),
      y: start.y + (end.y - start.y) * 0.9 + this.random(-30, 30),
    };

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const mt = 1 - t;
      const mt2 = mt * mt;
      const mt3 = mt2 * mt;

      points.push({
        x: mt3 * start.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * end.x,
        y: mt3 * start.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * end.y,
      });
    }

    return points;
  }

  /**
   * Move mouse along natural bezier path
   */
  static async moveMouseNaturally(page, toX, toY) {
    const viewport = page.viewportSize() || { width: 1280, height: 800 };

    // Get current position (random if first move)
    const fromX = this.random(100, viewport.width - 100);
    const fromY = this.random(100, viewport.height - 100);

    const path = this.generateBezierPath(
      { x: fromX, y: fromY },
      { x: toX, y: toY },
      this.random(15, 30)
    );

    for (const point of path) {
      await page.mouse.move(point.x, point.y);
      await sleep(this.random(5, 25)); // Small delay between moves
    }
  }

  /**
   * Smooth scroll like human (not instant)
   */
  static async smoothScroll(page, amount) {
    const steps = this.random(5, 12);
    const stepAmount = amount / steps;

    for (let i = 0; i < steps; i++) {
      await page.evaluate((scrollBy) => {
        window.scrollBy({
          top: scrollBy,
          behavior: 'auto', // We control smoothness ourselves
        });
      }, stepAmount + this.random(-20, 20));

      await sleep(this.random(30, 80));
    }
  }

  /**
   * Random mouse wiggle (humans don't keep mouse still)
   */
  static async mouseWiggle(page) {
    const viewport = page.viewportSize() || { width: 1280, height: 800 };
    const x = this.random(200, viewport.width - 200);
    const y = this.random(200, viewport.height - 200);

    await page.mouse.move(x, y);
    await sleep(this.random(50, 150));
    await page.mouse.move(x + this.random(-30, 30), y + this.random(-30, 30));
  }

  /**
   * Simulate reading pause (humans read content)
   */
  static async readingPause() {
    if (Math.random() < CONFIG.behavior.pauseChance) {
      const duration = this.random(
        CONFIG.behavior.minPauseDuration,
        CONFIG.behavior.maxPauseDuration
      );
      console.log(`   💭 Reading pause: ${(duration / 1000).toFixed(1)}s`);
      await sleep(duration);
    }
  }

  /**
   * Random viewport interaction (hover, small movements)
   */
  static async randomInteraction(page) {
    const actions = ['wiggle', 'scroll_tiny', 'hover_random'];
    const action = actions[this.random(0, actions.length - 1)];

    switch (action) {
      case 'wiggle':
        await this.mouseWiggle(page);
        break;
      case 'scroll_tiny':
        await page.evaluate(() => window.scrollBy(0, Math.random() * 50 - 25));
        break;
      case 'hover_random':
        const viewport = page.viewportSize() || { width: 1280, height: 800 };
        await page.mouse.move(
          this.random(100, viewport.width - 100),
          this.random(100, viewport.height - 100)
        );
        break;
    }
  }
}

// ============================================================================
// STEALTH UTILITIES
// ============================================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// ============================================================================
// CHROME LAUNCHER WITH STEALTH FLAGS
// ============================================================================

function findChromePath() {
  const chromePaths = [
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];

  for (const p of chromePaths) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('Chrome not found');
}

async function launchStealthChrome() {
  console.log('🛡️  Launching Chrome with stealth mode...');

  if (process.platform === 'win32') {
    console.log('   Closing existing Chrome...');
    await new Promise(resolve => {
      exec('taskkill /F /IM chrome.exe 2>nul', () => resolve());
    });
    await sleep(3000);
  }

  const chromePath = findChromePath();
  console.log(`📍 Chrome: ${chromePath}`);

  const userDataDir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
    : path.join(process.env.HOME || '', '.config', 'google-chrome');

  console.log(`📁 Profile: ${userDataDir}`);

  // Stealth Chrome flags - Windows compatible (no quotes in args)
  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1920,1080',
    '--start-maximized',
    '--disable-infobars',
    'https://facebook.com',
  ];

  // Use spawn instead of exec for better Windows compatibility
  const { spawn } = require('child_process');

  console.log('🚀 Launching stealth Chrome...');

  const chromeProcess = spawn(chromePath, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });

  chromeProcess.unref();

  // Wait longer for Chrome to start
  console.log('   Waiting for Chrome to start...');
  await sleep(5000);
}

// ============================================================================
// STEALTH SCRAPER CLASS
// ============================================================================

class StealthFacebookScraper {
  constructor() {
    this.browser = null;
    this.page = null;
    this.mousePosition = { x: 0, y: 0 };
  }

  async connect() {
    console.log('🔌 Connecting to Chrome CDP...');

    for (let i = 0; i < 15; i++) {
      try {
        process.stdout.write(`   Attempt ${i + 1}/15... `);
        this.browser = await chromium.connectOverCDP(CONFIG.cdpUrl);
        console.log('✅ Connected!');
        return true;
      } catch (e) {
        console.log('Retrying...');
        await sleep(1000);
      }
    }
    return false;
  }

  /**
   * Apply stealth patches to page
   */
  async applyStealthPatches() {
    if (!this.page) return;

    // Override navigator.webdriver
    await this.page.addInitScript(() => {
      // Remove webdriver flag
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Fix chrome object
      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {},
      };

      // Fix permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Fix plugins (real browser has plugins)
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' },
        ],
      });

      // Fix languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'vi'],
      });

      // Fix platform
      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
      });

      // Fix hardwareConcurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
      });

      // Fix deviceMemory
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
      });

      // Prevent detection via toString
      const originalFunction = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === window.navigator.permissions.query) {
          return 'function query() { [native code] }';
        }
        return originalFunction.call(this);
      };
    });

    console.log('🛡️  Stealth patches applied');
  }

  async findFacebookPage() {
    if (!this.browser) return false;

    const contexts = this.browser.contexts();
    if (contexts.length === 0) return false;

    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        if (page.url().includes('facebook.com')) {
          this.page = page;
          await this.applyStealthPatches();
          console.log(`✅ Found Facebook tab: ${page.url()}`);
          return true;
        }
      }
    }

    this.page = contexts[0].pages()[0];
    if (this.page) {
      await this.applyStealthPatches();
      console.log('📱 Navigating to Facebook...');
      await this.page.goto('https://www.facebook.com', { waitUntil: 'networkidle' });
      return true;
    }

    return false;
  }

  async checkLoggedIn() {
    if (!this.page) return false;

    // Human-like: move mouse while checking
    await HumanBehavior.mouseWiggle(this.page);

    const isLoggedIn = await this.page.evaluate(() => {
      return document.querySelector('[aria-label="Your profile"]') !== null ||
             document.querySelector('[aria-label="Account"]') !== null ||
             document.querySelector('[data-pagelet="Stories"]') !== null ||
             document.querySelector('[role="feed"]') !== null;
    });

    if (!isLoggedIn) {
      console.log('⚠️  Not logged in. Please log into Facebook...');
      console.log('   Waiting 30 seconds for manual login...');
      await sleep(30000);
      return this.checkLoggedIn();
    }

    console.log('✅ Logged in to Facebook');
    return true;
  }

  /**
   * Scrape with human-like behavior
   */
  async scrapeNewsfeed() {
    if (!this.page) throw new Error('Page not initialized');

    const startTime = Date.now();
    const posts = [];
    let scrollCount = 0;
    const seenKeys = new Set();

    console.log(`\n📰 Scraping ${CONFIG.postsToScrape} posts with human behavior...\n`);

    // Wait for feed with mouse movement
    try {
      await HumanBehavior.mouseWiggle(this.page);
      await this.page.waitForSelector('[role="feed"], [role="article"]', { timeout: 15000 });
    } catch (e) {
      console.log('⚠️  Feed selector timeout, continuing...');
    }

    // Initial pause (humans don't scroll immediately)
    console.log('   👀 Initial viewing pause...');
    await HumanBehavior.humanDelay(2000, 0.5);

    while (posts.length < CONFIG.postsToScrape && scrollCount < CONFIG.behavior.maxScrollAttempts) {
      // Random interaction before scraping
      if (Math.random() < 0.3) {
        await HumanBehavior.randomInteraction(this.page);
      }

      // Extract posts
      const extracted = await this.extractPosts();

      for (const post of extracted) {
        const key = `${post.author}:${post.content.slice(0, 50)}`;
        if (!seenKeys.has(key) && post.content.length > 20) {
          seenKeys.add(key);
          post.index = posts.length + 1;
          posts.push(post);

          const preview = post.content.slice(0, 50).replace(/\n/g, ' ');
          console.log(`  ✓ [${posts.length}] ${post.author}: ${preview}...`);

          if (posts.length >= CONFIG.postsToScrape) break;
        }
      }

      // Human-like reading pause
      await HumanBehavior.readingPause();

      // Smooth scroll with random amount
      const scrollAmount = HumanBehavior.random(
        CONFIG.behavior.minScrollAmount,
        CONFIG.behavior.maxScrollAmount
      );

      console.log(`   📜 Scroll ${scrollCount + 1}: ${scrollAmount}px`);
      await HumanBehavior.smoothScroll(this.page, scrollAmount);

      // Random delay between scrolls
      const delay = HumanBehavior.random(
        CONFIG.behavior.minScrollDelay,
        CONFIG.behavior.maxScrollDelay
      );
      await sleep(delay);

      // Occasional mouse movement
      if (CONFIG.behavior.mouseMovementEnabled && Math.random() < 0.4) {
        await HumanBehavior.mouseWiggle(this.page);
      }

      scrollCount++;
    }

    console.log(`\n✅ Collected ${posts.length} posts in ${scrollCount} scrolls`);

    return {
      posts,
      scrapedAt: new Date(),
      totalScrolls: scrollCount,
      executionTimeMs: Date.now() - startTime,
      stealthMode: true,
    };
  }

  async extractPosts() {
    if (!this.page) return [];

    return await this.page.evaluate(() => {
      const results = [];

      const selectors = [
        '[data-pagelet^="FeedUnit"]',
        '[role="article"]',
        '.x1yztbdb.x1n2onr6.xh8yej3.x1ja2u2z',
      ];

      let postElements = [];
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          postElements = Array.from(els);
          break;
        }
      }

      postElements.forEach((el) => {
        try {
          const allText = el.textContent || '';

          // Author
          const authorEl = el.querySelector('a[role="link"] strong, h4 a, strong');
          const author = authorEl?.textContent?.trim() || 'Unknown';

          // Timestamp
          const timeEl = el.querySelector('a[href*="/posts/"], a[href*="story_fbid"], abbr');
          let timestamp = '';
          if (timeEl) {
            const text = timeEl.textContent || '';
            const match = text.match(/\d+\s*(h|m|d|giờ|phút|ngày|hour|minute|day)/i);
            timestamp = match ? match[0] : text.slice(0, 20);
          }

          // Content
          let content = '';
          const contentSelectors = [
            '[data-ad-preview="message"]',
            'div[dir="auto"]:not(a):not(span)',
          ];

          for (const sel of contentSelectors) {
            const contentEl = el.querySelector(sel);
            if (contentEl?.textContent?.length > 20) {
              content = contentEl.textContent.trim();
              break;
            }
          }

          if (!content) {
            const clone = el.cloneNode(true);
            clone.querySelectorAll('[aria-label*="reaction"], [aria-label*="comment"]').forEach(e => e.remove());
            content = (clone.textContent || '').slice(0, 600).trim();
          }

          // Link info
          const domainEl = el.querySelector('span.x193iq5w');
          const linkDomain = domainEl?.textContent?.trim();

          // Engagement
          const parseNum = (patterns) => {
            for (const pattern of patterns) {
              const match = allText.match(pattern);
              if (match) {
                let num = parseFloat(match[1].replace(/,/g, ''));
                if (match[1].toLowerCase().includes('k')) num *= 1000;
                if (match[1].toLowerCase().includes('m')) num *= 1000000;
                return Math.round(num);
              }
            }
            return 0;
          };

          const reactions = parseNum([/(\d+(?:[,.\d]*)?[KkMm]?)\s*(?:reactions?|likes?|thích)/i]);
          const comments = parseNum([/(\d+(?:[,.\d]*)?[KkMm]?)\s*(?:comments?|bình luận)/i]);
          const shares = parseNum([/(\d+(?:[,.\d]*)?[KkMm]?)\s*(?:shares?|chia sẻ)/i]);

          const hasImage = el.querySelector('img[src*="scontent"]') !== null;
          const hasVideo = el.querySelector('video, [data-video-id]') !== null;

          let authorType = 'unknown';
          const textLower = allText.toLowerCase();
          if (textLower.includes('sponsored') || textLower.includes('được tài trợ')) {
            authorType = 'sponsored';
          } else if (el.querySelector('[aria-label*="Verified"]')) {
            authorType = 'page';
          } else if (el.querySelector('a[href*="/groups/"]')) {
            authorType = 'group';
          } else if (linkDomain) {
            authorType = 'page';
          } else {
            authorType = 'friend';
          }

          if (content.length > 20) {
            results.push({
              index: 0,
              author,
              authorType,
              timestamp,
              content: content.slice(0, 800),
              linkDomain,
              reactions,
              comments,
              shares,
              hasImage,
              hasVideo,
            });
          }
        } catch (e) {}
      });

      return results;
    });
  }

  async disconnect() {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ============================================================================
// LLM SUMMARIZER
// ============================================================================

async function summarizeWithLLM(posts) {
  const OpenAI = require('openai').default;
  const openai = new OpenAI();

  const postText = posts.map((p) =>
    `[${p.index}] **${p.author}** (${p.authorType}) - ${p.timestamp || 'gần đây'}
${p.content}
${p.linkDomain ? `📎 ${p.linkDomain}` : ''}
👍 ${p.reactions} • 💬 ${p.comments} • 🔄 ${p.shares}`
  ).join('\n\n---\n\n');

  const response = await openai.chat.completions.create({
    model: CONFIG.openaiModel,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Tóm tắt ${posts.length} bài post Facebook bằng tiếng Việt:
1. Mỗi bài quan trọng: nguồn + tóm tắt 1-2 câu
2. Thống kê theo chủ đề
3. Top 3 engagement cao nhất
4. Nhận xét xu hướng

---

${postText}`,
    }],
  });

  return response.choices[0]?.message?.content || 'Không thể tạo tóm tắt.';
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('═'.repeat(60));
  console.log('  🛡️  FACEBOOK STEALTH SCRAPER');
  console.log('  Anti-Bot Detection Bypass Mode');
  console.log('═'.repeat(60) + '\n');

  const scraper = new StealthFacebookScraper();

  try {
    let connected = await scraper.connect();

    if (!connected) {
      await launchStealthChrome();
      connected = await scraper.connect();
    }

    if (!connected) {
      console.error('\n❌ Failed to connect to Chrome.');
      process.exit(1);
    }

    const foundPage = await scraper.findFacebookPage();
    if (!foundPage) {
      console.error('❌ Could not find Facebook page.');
      process.exit(1);
    }

    const loggedIn = await scraper.checkLoggedIn();
    if (!loggedIn) {
      console.error('❌ Not logged in to Facebook.');
      process.exit(1);
    }

    const result = await scraper.scrapeNewsfeed();

    if (result.posts.length === 0) {
      console.log('\n❌ No posts found.');
      process.exit(1);
    }

    // Print posts
    console.log('\n' + '═'.repeat(60));
    console.log('📋 SCRAPED POSTS');
    console.log('═'.repeat(60));

    result.posts.forEach((p) => {
      console.log(`\n[${p.index}] ${p.author} (${p.authorType}) - ${p.timestamp}`);
      console.log(`    ${p.content.slice(0, 120).replace(/\n/g, ' ')}...`);
      if (p.linkDomain) console.log(`    🔗 ${p.linkDomain}`);
      console.log(`    📊 ${formatNumber(p.reactions)}👍 ${formatNumber(p.comments)}💬 ${formatNumber(p.shares)}🔄`);
    });

    // LLM Summary
    if (CONFIG.useLLMSummary) {
      console.log('\n' + '═'.repeat(60));
      console.log('🤖 AI SUMMARY');
      console.log('═'.repeat(60) + '\n');

      try {
        const summary = await summarizeWithLLM(result.posts);
        console.log(summary);
        result.summary = summary;
      } catch (e) {
        console.log(`⚠️  LLM failed: ${e.message}`);
      }
    }

    // Save
    ensureDir(CONFIG.outputDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = `${CONFIG.outputDir}/stealth-scrape-${timestamp}.json`;

    fs.writeFileSync(outputPath, JSON.stringify({ ...result, config: CONFIG }, null, 2));

    console.log('\n' + '═'.repeat(60));
    console.log('📊 STEALTH SCRAPE SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Posts:       ${result.posts.length}`);
    console.log(`Scrolls:     ${result.totalScrolls}`);
    console.log(`Time:        ${(result.executionTimeMs / 1000).toFixed(1)}s`);
    console.log(`Saved:       ${outputPath}`);
    console.log('═'.repeat(60));

    console.log('\n🛡️  ANTI-DETECTION MEASURES USED:');
    console.log('─'.repeat(40));
    console.log('✅ navigator.webdriver removed');
    console.log('✅ Chrome object spoofed');
    console.log('✅ Plugins array populated');
    console.log('✅ Bezier curve mouse movement');
    console.log('✅ Smooth scrolling (not instant)');
    console.log('✅ Random reading pauses');
    console.log('✅ Variable scroll amounts');
    console.log('✅ Mouse wiggle simulation');
    console.log('✅ Real Chrome profile (not headless)');
    console.log('─'.repeat(40) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await scraper.disconnect();
  }
}

main();
