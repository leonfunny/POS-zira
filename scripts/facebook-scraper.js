/**
 * Facebook Newsfeed Scraper (JavaScript version)
 *
 * Usage:
 *   node scripts/facebook-scraper.js
 *   npm run scrape:fb
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
  scrollDelay: 1500,
  scrollAmount: 600,
  maxScrollAttempts: 25,
  outputDir: './facebook-scrapes',
  useLLMSummary: true,
  openaiModel: 'gpt-4o-mini',
};

// ============================================================================
// UTILITIES
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
// CHROME LAUNCHER
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
    if (p && fs.existsSync(p)) {
      return p;
    }
  }
  throw new Error('Chrome not found');
}

async function launchChromeWithDebugging() {
  console.log('🔧 Preparing Chrome...');

  if (process.platform === 'win32') {
    await new Promise(resolve => {
      exec('taskkill /F /IM chrome.exe', () => resolve());
    });
    await sleep(2000);
  }

  const chromePath = findChromePath();
  console.log(`📍 Chrome: ${chromePath}`);

  const userDataDir = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
    : path.join(process.env.HOME || '', '.config', 'google-chrome');

  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir="${userDataDir}"`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--profile-directory=Default',
    'https://facebook.com',
  ];

  const cmd = `"${chromePath}" ${args.join(' ')}`;
  console.log('🚀 Launching Chrome...');

  const chromeProcess = exec(cmd);
  chromeProcess.unref();
  await sleep(3000);
}

// ============================================================================
// SCRAPER CLASS
// ============================================================================

class FacebookScraper {
  constructor() {
    this.browser = null;
    this.page = null;
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

    console.error('❌ Could not connect to Chrome.');
    return false;
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
          console.log(`✅ Found Facebook tab: ${page.url()}`);
          return true;
        }
      }
    }

    this.page = contexts[0].pages()[0];
    if (this.page) {
      console.log('📱 Navigating to Facebook...');
      await this.page.goto('https://www.facebook.com', { waitUntil: 'networkidle' });
      return true;
    }

    return false;
  }

  async checkLoggedIn() {
    if (!this.page) return false;

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

  async scrapeNewsfeed() {
    if (!this.page) throw new Error('Page not initialized');

    const startTime = Date.now();
    const posts = [];
    let scrollCount = 0;
    const seenKeys = new Set();

    console.log(`\n📰 Scraping ${CONFIG.postsToScrape} posts...\n`);

    try {
      await this.page.waitForSelector('[role="feed"], [role="article"], [data-pagelet^="FeedUnit"]', {
        timeout: 15000
      });
    } catch (e) {
      console.log('⚠️  Feed selector timeout, continuing...');
    }

    while (posts.length < CONFIG.postsToScrape && scrollCount < CONFIG.maxScrollAttempts) {
      const extracted = await this.extractPosts();

      for (const post of extracted) {
        const key = `${post.author}:${post.content.slice(0, 50)}`;
        if (!seenKeys.has(key) && post.content.length > 20) {
          seenKeys.add(key);
          post.index = posts.length + 1;
          posts.push(post);

          const preview = post.content.slice(0, 60).replace(/\n/g, ' ');
          console.log(`  ✓ [${posts.length}] ${post.author}: ${preview}...`);

          if (posts.length >= CONFIG.postsToScrape) break;
        }
      }

      await this.page.evaluate((amount) => window.scrollBy(0, amount), CONFIG.scrollAmount);
      scrollCount++;
      await sleep(CONFIG.scrollDelay);
    }

    console.log(`\n✅ Collected ${posts.length} posts in ${scrollCount} scrolls`);

    return {
      posts,
      scrapedAt: new Date(),
      totalScrolls: scrollCount,
      executionTimeMs: Date.now() - startTime,
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
        'div[class*="x1lliihq"]',
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
          const authorEl = el.querySelector('a[role="link"] strong, h4 a, strong, span[dir="auto"] > span');
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
            if (contentEl && contentEl.textContent && contentEl.textContent.length > 20) {
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
          const linkEl = el.querySelector('a[href*="l.facebook.com"], a[data-lynx-mode]');
          const linkTitle = linkEl?.textContent?.trim();
          const domainEl = el.querySelector('span.x193iq5w');
          const linkDomain = domainEl?.textContent?.trim();

          // Engagement
          const parseEngagement = (text, patterns) => {
            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match) {
                const numStr = match[1].replace(/,/g, '');
                let num = parseFloat(numStr);
                if (match[1].toLowerCase().includes('k')) num *= 1000;
                if (match[1].toLowerCase().includes('m')) num *= 1000000;
                return Math.round(num);
              }
            }
            return 0;
          };

          const reactions = parseEngagement(allText, [
            /(\d+(?:[,.\d]*)?[KkMm]?)\s*(?:reactions?|likes?|thích)/i,
          ]);
          const comments = parseEngagement(allText, [
            /(\d+(?:[,.\d]*)?[KkMm]?)\s*(?:comments?|bình luận)/i,
          ]);
          const shares = parseEngagement(allText, [
            /(\d+(?:[,.\d]*)?[KkMm]?)\s*(?:shares?|chia sẻ)/i,
          ]);

          // Media
          const hasImage = el.querySelector('img[src*="scontent"]') !== null;
          const hasVideo = el.querySelector('video, [data-video-id]') !== null;

          // Author type
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

          if (content.length > 20 || linkTitle) {
            results.push({
              index: 0,
              author,
              authorType,
              timestamp,
              content: content.slice(0, 800),
              linkTitle,
              linkDomain,
              reactions,
              comments,
              shares,
              hasImage,
              hasVideo,
            });
          }
        } catch (e) {
          // Skip
        }
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
      content: `Bạn là trợ lý tóm tắt tin tức. Hãy tóm tắt ${posts.length} bài post Facebook sau bằng tiếng Việt.

**Yêu cầu:**
1. Với mỗi bài quan trọng: ghi nguồn, tóm tắt 1-2 câu
2. Thống kê theo chủ đề
3. Top 3 bài engagement cao nhất
4. Nhận xét xu hướng newsfeed

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
  console.log('  📱 FACEBOOK NEWSFEED SCRAPER');
  console.log('═'.repeat(60) + '\n');

  const scraper = new FacebookScraper();

  try {
    let connected = await scraper.connect();

    if (!connected) {
      await launchChromeWithDebugging();
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
    console.log('📋 RAW POSTS');
    console.log('═'.repeat(60));

    result.posts.forEach((p) => {
      console.log(`\n[${p.index}] ${p.author} (${p.authorType}) - ${p.timestamp}`);
      console.log(`    ${p.content.slice(0, 150).replace(/\n/g, ' ')}...`);
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
    const outputPath = `${CONFIG.outputDir}/scrape-${timestamp}.json`;

    fs.writeFileSync(outputPath, JSON.stringify({ ...result, config: CONFIG }, null, 2));

    console.log('\n' + '═'.repeat(60));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Posts:       ${result.posts.length}`);
    console.log(`Scrolls:     ${result.totalScrolls}`);
    console.log(`Time:        ${(result.executionTimeMs / 1000).toFixed(1)}s`);
    console.log(`Saved:       ${outputPath}`);
    console.log('═'.repeat(60) + '\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
  } finally {
    await scraper.disconnect();
  }
}

main();
