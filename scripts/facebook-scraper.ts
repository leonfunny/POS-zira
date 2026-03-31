/**
 * Facebook Newsfeed Scraper
 *
 * Scrapes posts from Facebook newsfeed using Chrome DevTools Protocol
 * Connects to existing Chrome browser (already logged into Facebook)
 *
 * SETUP:
 * 1. Run: npm run scrape:fb
 *    (Script will auto-launch Chrome with debugging port)
 *
 * 2. Make sure you're logged into Facebook
 *
 * Requirements already in package.json:
 *   - rebrowser-playwright-core
 *   - openai (for summarization)
 */

import { chromium, Browser, Page, BrowserContext } from 'rebrowser-playwright-core';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // CDP connection
  cdpUrl: 'http://127.0.0.1:9222',

  // Scraping settings
  postsToScrape: 10,
  scrollDelay: 1500,      // ms between scrolls
  scrollAmount: 600,      // pixels per scroll
  maxScrollAttempts: 25,

  // Output
  outputDir: './facebook-scrapes',

  // LLM summarization (uses OpenAI since it's in package.json)
  useLLMSummary: true,
  openaiModel: 'gpt-4o-mini',
};

// ============================================================================
// TYPES
// ============================================================================

interface FacebookPost {
  index: number;
  author: string;
  authorType: 'page' | 'friend' | 'sponsored' | 'group' | 'unknown';
  timestamp: string;
  content: string;
  linkTitle?: string;
  linkDomain?: string;
  reactions: number;
  comments: number;
  shares: number;
  hasImage: boolean;
  hasVideo: boolean;
}

interface ScrapeResult {
  posts: FacebookPost[];
  scrapedAt: Date;
  totalScrolls: number;
  executionTimeMs: number;
  summary?: string;
}

// ============================================================================
// CHROME LAUNCHER
// ============================================================================

async function findChromePath(): Promise<string> {
  const chromePaths = [
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    // Mac
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];

  for (const p of chromePaths) {
    if (p && fs.existsSync(p)) {
      return p;
    }
  }

  throw new Error('Chrome not found. Please set CHROME_PATH environment variable.');
}

async function launchChromeWithDebugging(): Promise<void> {
  console.log('🔧 Preparing Chrome...');

  // Kill existing Chrome (Windows only)
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      exec('taskkill /F /IM chrome.exe', () => resolve());
    });
    await sleep(2000);
  }

  const chromePath = await findChromePath();
  console.log(`📍 Chrome found: ${chromePath}`);

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
  console.log(`🚀 Launching Chrome...`);

  const chromeProcess = exec(cmd);
  chromeProcess.unref();

  // Wait for Chrome to start
  await sleep(3000);
}

// ============================================================================
// FACEBOOK SCRAPER
// ============================================================================

class FacebookScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async connect(): Promise<boolean> {
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

  async findFacebookPage(): Promise<boolean> {
    if (!this.browser) return false;

    const contexts = this.browser.contexts();
    if (contexts.length === 0) {
      console.error('❌ No browser contexts found.');
      return false;
    }

    // Find Facebook tab
    for (const context of contexts) {
      const pages = context.pages();
      for (const page of pages) {
        const url = page.url();
        if (url.includes('facebook.com')) {
          this.page = page;
          console.log(`✅ Found Facebook tab: ${url}`);
          return true;
        }
      }
    }

    // If no Facebook tab, use first page
    this.page = contexts[0].pages()[0];
    if (this.page) {
      console.log('📱 Navigating to Facebook...');
      await this.page.goto('https://www.facebook.com', { waitUntil: 'networkidle' });
      return true;
    }

    return false;
  }

  async checkLoggedIn(): Promise<boolean> {
    if (!this.page) return false;

    const isLoggedIn = await this.page.evaluate(() => {
      return document.querySelector('[aria-label="Your profile"]') !== null ||
             document.querySelector('[aria-label="Account"]') !== null ||
             document.querySelector('[data-pagelet="Stories"]') !== null ||
             document.querySelector('[role="feed"]') !== null;
    });

    if (!isLoggedIn) {
      console.log('⚠️  Not logged in. Please log into Facebook in the browser window.');
      console.log('   Waiting 30 seconds for manual login...');
      await sleep(30000);
      return this.checkLoggedIn();
    }

    console.log('✅ Logged in to Facebook');
    return true;
  }

  async scrapeNewsfeed(): Promise<ScrapeResult> {
    if (!this.page) throw new Error('Page not initialized');

    const startTime = Date.now();
    const posts: FacebookPost[] = [];
    let scrollCount = 0;
    const seenKeys = new Set<string>();

    console.log(`\n📰 Scraping ${CONFIG.postsToScrape} posts...\n`);

    // Wait for feed to load
    try {
      await this.page.waitForSelector('[role="feed"], [role="article"], [data-pagelet^="FeedUnit"]', {
        timeout: 15000
      });
    } catch (e) {
      console.log('⚠️  Feed selector timeout, continuing anyway...');
    }

    while (posts.length < CONFIG.postsToScrape && scrollCount < CONFIG.maxScrollAttempts) {
      // Extract posts from current view
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

      // Scroll down
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

  private async extractPosts(): Promise<FacebookPost[]> {
    if (!this.page) return [];

    return await this.page.evaluate(() => {
      const results: any[] = [];

      // Multiple selectors for Facebook posts (FB changes these frequently)
      const selectors = [
        '[data-pagelet^="FeedUnit"]',
        '[role="article"]',
        '.x1yztbdb.x1n2onr6.xh8yej3.x1ja2u2z',
        'div[class*="x1lliihq"]',
      ];

      let postElements: Element[] = [];
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
          const timeEl = el.querySelector('a[href*="/posts/"], a[href*="story_fbid"], abbr, span[id*="jsc"]');
          let timestamp = '';
          if (timeEl) {
            const text = timeEl.textContent || '';
            const match = text.match(/\d+\s*(h|m|d|giờ|phút|ngày|hour|minute|day|hr|min)/i);
            timestamp = match ? match[0] : text.slice(0, 20);
          }

          // Content
          let content = '';
          const contentSelectors = [
            '[data-ad-preview="message"]',
            'div[dir="auto"]:not(a):not(span)',
            'div[data-ad-comet-preview="message"]',
          ];

          for (const sel of contentSelectors) {
            const contentEl = el.querySelector(sel);
            if (contentEl && contentEl.textContent && contentEl.textContent.length > 20) {
              content = contentEl.textContent.trim();
              break;
            }
          }

          if (!content) {
            // Fallback: get visible text excluding engagement area
            const clone = el.cloneNode(true) as Element;
            clone.querySelectorAll('[aria-label*="reaction"], [aria-label*="comment"], [aria-label*="share"]').forEach(e => e.remove());
            content = (clone.textContent || '').slice(0, 600).trim();
          }

          // Link info
          const linkEl = el.querySelector('a[href*="l.facebook.com"], a[data-lynx-mode]');
          const linkTitle = linkEl?.textContent?.trim();
          const domainEl = el.querySelector('span.x193iq5w, span[class*="xt0psk2"]');
          const linkDomain = domainEl?.textContent?.trim();

          // Engagement metrics
          const parseEngagement = (text: string, patterns: RegExp[]): number => {
            for (const pattern of patterns) {
              const match = text.match(pattern);
              if (match) {
                const numStr = match[1].replace(/,/g, '').replace(/\./g, '');
                let num = parseFloat(numStr);
                if (match[1].toLowerCase().includes('k') || match[1].toLowerCase().includes('n')) num *= 1000;
                if (match[1].toLowerCase().includes('m') || match[1].toLowerCase().includes('tr')) num *= 1000000;
                return Math.round(num);
              }
            }
            return 0;
          };

          const reactions = parseEngagement(allText, [
            /(\d+(?:[,.\d]*)?[KkMmNn]?)\s*(?:reactions?|likes?|thích|cảm xúc)/i,
            /(\d+(?:[,.\d]*)?[KkMmNn]?)\s*$/i,
          ]);

          const comments = parseEngagement(allText, [
            /(\d+(?:[,.\d]*)?[KkMmNn]?)\s*(?:comments?|bình luận)/i,
          ]);

          const shares = parseEngagement(allText, [
            /(\d+(?:[,.\d]*)?[KkMmNn]?)\s*(?:shares?|chia sẻ|lượt chia sẻ)/i,
          ]);

          // Media detection
          const hasImage = el.querySelector('img[src*="scontent"], img[src*="fbcdn"]') !== null;
          const hasVideo = el.querySelector('video, [data-video-id], [aria-label*="video"]') !== null;

          // Author type
          let authorType: 'page' | 'friend' | 'sponsored' | 'group' | 'unknown' = 'unknown';
          const textLower = allText.toLowerCase();
          if (textLower.includes('sponsored') || textLower.includes('được tài trợ')) {
            authorType = 'sponsored';
          } else if (el.querySelector('[aria-label*="Verified"], svg[aria-label*="verified"]')) {
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
          // Skip problematic posts
        }
      });

      return results;
    });
  }

  async disconnect(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }
}

// ============================================================================
// LLM SUMMARIZER (OpenAI)
// ============================================================================

async function summarizeWithLLM(posts: FacebookPost[]): Promise<string> {
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI();

  const postText = posts.map((p) =>
    `[${p.index}] **${p.author}** (${p.authorType}) - ${p.timestamp || 'gần đây'}
${p.content}
${p.linkDomain ? `📎 ${p.linkDomain}` : ''}
👍 ${p.reactions} • 💬 ${p.comments} • 🔄 ${p.shares}
${p.hasImage ? '🖼️' : ''}${p.hasVideo ? '🎥' : ''}`
  ).join('\n\n---\n\n');

  const response = await openai.chat.completions.create({
    model: CONFIG.openaiModel,
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `Bạn là trợ lý tóm tắt tin tức. Hãy tóm tắt ${posts.length} bài post Facebook sau bằng tiếng Việt.

**Yêu cầu:**
1. Với mỗi bài quan trọng:
   - Ghi nguồn và thời gian
   - Tóm tắt nội dung chính (1-2 câu)
   - Note engagement nếu cao bất thường

2. Cuối cùng:
   - Thống kê theo chủ đề (chính trị, kinh doanh, giải trí, công nghệ, etc.)
   - Top 3 bài có engagement cao nhất
   - Nhận xét về xu hướng newsfeed hôm nay

---

${postText}`,
    }],
  });

  return response.choices[0]?.message?.content || 'Không thể tạo tóm tắt.';
}

// ============================================================================
// UTILITIES
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
  console.log('═'.repeat(60));
  console.log('  📱 FACEBOOK NEWSFEED SCRAPER');
  console.log('═'.repeat(60) + '\n');

  const scraper = new FacebookScraper();

  try {
    // Try to connect to existing Chrome first
    let connected = await scraper.connect();

    if (!connected) {
      // Launch Chrome with debugging
      await launchChromeWithDebugging();
      connected = await scraper.connect();
    }

    if (!connected) {
      console.error('\n❌ Failed to connect to Chrome.');
      console.error('Please run Chrome manually with:');
      console.error('  chrome --remote-debugging-port=9222\n');
      process.exit(1);
    }

    // Find Facebook page
    const foundPage = await scraper.findFacebookPage();
    if (!foundPage) {
      console.error('❌ Could not find or create Facebook page.');
      process.exit(1);
    }

    // Check login
    const loggedIn = await scraper.checkLoggedIn();
    if (!loggedIn) {
      console.error('❌ Not logged in to Facebook.');
      process.exit(1);
    }

    // Scrape newsfeed
    const result = await scraper.scrapeNewsfeed();

    if (result.posts.length === 0) {
      console.log('\n❌ No posts found. Facebook may have changed their layout.');
      process.exit(1);
    }

    // Print raw posts
    console.log('\n' + '═'.repeat(60));
    console.log('📋 RAW POSTS');
    console.log('═'.repeat(60));

    result.posts.forEach((p) => {
      console.log(`\n[${p.index}] ${p.author} (${p.authorType}) - ${p.timestamp}`);
      console.log(`    ${p.content.slice(0, 150).replace(/\n/g, ' ')}${p.content.length > 150 ? '...' : ''}`);
      if (p.linkDomain) console.log(`    🔗 ${p.linkDomain}`);
      console.log(`    📊 ${formatNumber(p.reactions)}👍 ${formatNumber(p.comments)}💬 ${formatNumber(p.shares)}🔄`);
      if (p.hasImage) process.stdout.write('    🖼️ Image');
      if (p.hasVideo) process.stdout.write('    🎥 Video');
      if (p.hasImage || p.hasVideo) console.log('');
    });

    // LLM Summary
    if (CONFIG.useLLMSummary && result.posts.length > 0) {
      console.log('\n' + '═'.repeat(60));
      console.log('🤖 AI SUMMARY');
      console.log('═'.repeat(60) + '\n');

      try {
        const summary = await summarizeWithLLM(result.posts);
        console.log(summary);
        result.summary = summary;
      } catch (e: any) {
        console.log(`⚠️  LLM summarization failed: ${e.message}`);
        console.log('   Set OPENAI_API_KEY environment variable to enable summaries.');
      }
    }

    // Save results
    ensureDir(CONFIG.outputDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputPath = `${CONFIG.outputDir}/scrape-${timestamp}.json`;

    fs.writeFileSync(outputPath, JSON.stringify({
      ...result,
      config: CONFIG,
    }, null, 2));

    console.log('\n' + '═'.repeat(60));
    console.log('📊 SUMMARY');
    console.log('═'.repeat(60));
    console.log(`Posts scraped:    ${result.posts.length}`);
    console.log(`Total scrolls:    ${result.totalScrolls}`);
    console.log(`Execution time:   ${(result.executionTimeMs / 1000).toFixed(1)}s`);
    console.log(`Output saved:     ${outputPath}`);
    console.log('═'.repeat(60) + '\n');

    // Cost comparison
    const inputTokens = result.posts.reduce((sum, p) => sum + (p.content.length / 4), 0) + 500;
    const outputTokens = (result.summary?.length || 0) / 4 + 500;
    const textCost = (inputTokens * 0.15 + outputTokens * 0.6) / 1000000; // gpt-4o-mini pricing

    console.log('💰 COST ESTIMATE (vs Vision approach)');
    console.log('─'.repeat(40));
    console.log(`This script (text):    ~$${textCost.toFixed(4)}`);
    console.log(`Vision (screenshots):  ~$0.0300`);
    console.log(`Savings:               ${((0.03 - textCost) / 0.03 * 100).toFixed(0)}%`);
    console.log('─'.repeat(40) + '\n');

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    if (error.stack) console.error(error.stack);
  } finally {
    await scraper.disconnect();
  }
}

// Run
main().catch(console.error);
