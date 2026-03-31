/**
 * Human Behavior Simulation for Browser Automation
 * Makes bot actions appear human-like to avoid detection
 *
 * Based on research from:
 * - https://github.com/riflosnake/HumanCursor
 * - https://github.com/DedInc/emunium
 * - https://github.com/waxei/human_behavior_playwright
 * - Bézier curves for mouse movement (Fitts's Law)
 */

import { Page } from 'rebrowser-playwright-core';
import logger from '../logger';

// ============================================================================
// RANDOM UTILITIES
// ============================================================================

/**
 * Random number between min and max (inclusive)
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Random float between min and max
 */
function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/**
 * Gaussian (normal) distribution random number
 * More realistic than uniform distribution for human behavior
 */
function gaussianRandom(mean: number, stdDev: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return num * stdDev + mean;
}

/**
 * Clamp value between min and max
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// HUMAN-LIKE DELAYS
// ============================================================================

/**
 * Human-like delay with Gaussian distribution
 * Humans don't have perfectly consistent timing
 */
export async function humanDelay(baseMs: number, variance: number = 0.3): Promise<void> {
  const delay = clamp(
    gaussianRandom(baseMs, baseMs * variance),
    baseMs * 0.5,
    baseMs * 2
  );
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Short pause (like reading or thinking)
 */
export async function shortPause(): Promise<void> {
  await humanDelay(randomInt(200, 800));
}

/**
 * Medium pause (like deciding what to do next)
 */
export async function mediumPause(): Promise<void> {
  await humanDelay(randomInt(1000, 3000));
}

/**
 * Long pause (like reading content)
 */
export async function longPause(): Promise<void> {
  await humanDelay(randomInt(3000, 8000));
}

/**
 * Random pause to simulate human inconsistency
 */
export async function randomPause(): Promise<void> {
  const pauseType = Math.random();
  if (pauseType < 0.5) {
    await shortPause();
  } else if (pauseType < 0.85) {
    await mediumPause();
  } else {
    await longPause();
  }
}

// ============================================================================
// BÉZIER CURVE MOUSE MOVEMENT
// ============================================================================

interface Point {
  x: number;
  y: number;
}

/**
 * Calculate point on cubic Bézier curve
 * Creates smooth, curved paths like human mouse movement
 */
function bezierPoint(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Generate random control points for Bézier curve
 * Creates natural-looking curves with slight randomness
 */
function generateControlPoints(start: Point, end: Point): [Point, Point] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Control points deviate more for longer distances
  const deviation = Math.min(distance * 0.3, 100);

  const cp1: Point = {
    x: start.x + dx * randomFloat(0.2, 0.4) + randomFloat(-deviation, deviation),
    y: start.y + dy * randomFloat(0.2, 0.4) + randomFloat(-deviation, deviation),
  };

  const cp2: Point = {
    x: start.x + dx * randomFloat(0.6, 0.8) + randomFloat(-deviation, deviation),
    y: start.y + dy * randomFloat(0.6, 0.8) + randomFloat(-deviation, deviation),
  };

  return [cp1, cp2];
}

/**
 * Generate human-like mouse path using Bézier curves
 */
function generateMousePath(start: Point, end: Point, steps: number = 50): Point[] {
  const [cp1, cp2] = generateControlPoints(start, end);
  const path: Point[] = [];

  for (let i = 0; i <= steps; i++) {
    // Non-linear t distribution (slower at start/end, faster in middle)
    // Simulates acceleration/deceleration of human movement
    const t = i / steps;
    const easedT = t < 0.5
      ? 2 * t * t
      : 1 - Math.pow(-2 * t + 2, 2) / 2;

    const point = bezierPoint(easedT, start, cp1, cp2, end);

    // Add micro-jitter for realism
    path.push({
      x: point.x + randomFloat(-1, 1),
      y: point.y + randomFloat(-1, 1),
    });
  }

  return path;
}

/**
 * Move mouse along a human-like path
 */
export async function humanMouseMove(page: Page, targetX: number, targetY: number): Promise<void> {
  try {
    // Get current mouse position (approximate from viewport center if unknown)
    const viewport = page.viewportSize() || { width: 1920, height: 1080 };
    const currentPos = {
      x: randomInt(viewport.width * 0.3, viewport.width * 0.7),
      y: randomInt(viewport.height * 0.3, viewport.height * 0.7),
    };

    const targetPos = { x: targetX, y: targetY };
    const distance = Math.sqrt(
      Math.pow(targetPos.x - currentPos.x, 2) + Math.pow(targetPos.y - currentPos.y, 2)
    );

    // More steps for longer distances (Fitts's Law)
    const steps = Math.max(20, Math.min(100, Math.floor(distance / 10)));
    const path = generateMousePath(currentPos, targetPos, steps);

    // Move along path with variable speed
    for (let i = 0; i < path.length; i++) {
      const point = path[i];

      // Variable delay based on position in movement (slower at ends)
      const progress = i / path.length;
      const speedFactor = 1 - Math.abs(progress - 0.5) * 0.5; // Faster in middle
      const delay = randomInt(2, 8) / speedFactor;

      await page.mouse.move(point.x, point.y);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    logger.debug(`[HumanBehavior] Mouse moved to (${targetX}, ${targetY})`);
  } catch (error: any) {
    logger.warn(`[HumanBehavior] Mouse move failed: ${error.message}`);
    // Fallback to direct move
    await page.mouse.move(targetX, targetY);
  }
}

/**
 * Human-like click with mouse movement and timing variation
 */
export async function humanClick(page: Page, x: number, y: number, options?: {
  button?: 'left' | 'right' | 'middle';
  doubleClick?: boolean;
}): Promise<void> {
  const { button = 'left', doubleClick = false } = options || {};

  // Move to target first
  await humanMouseMove(page, x, y);

  // Small pause before clicking (like human hesitation)
  await humanDelay(randomInt(50, 200));

  // Add slight position variation (humans don't click exactly on target)
  const clickX = x + randomFloat(-2, 2);
  const clickY = y + randomFloat(-2, 2);

  if (doubleClick) {
    await page.mouse.dblclick(clickX, clickY, { button });
  } else {
    // Variable click duration
    await page.mouse.down({ button });
    await humanDelay(randomInt(50, 150)); // Hold duration
    await page.mouse.up({ button });
  }

  // Small pause after clicking
  await humanDelay(randomInt(100, 300));

  logger.debug(`[HumanBehavior] Clicked at (${x}, ${y})`);
}

/**
 * Human-like element click
 */
export async function humanClickElement(page: Page, selector: string): Promise<boolean> {
  try {
    const element = await page.$(selector);
    if (!element) {
      logger.warn(`[HumanBehavior] Element not found: ${selector}`);
      return false;
    }

    const box = await element.boundingBox();
    if (!box) {
      logger.warn(`[HumanBehavior] Element has no bounding box: ${selector}`);
      return false;
    }

    // Click at random position within element (not always center)
    const clickX = box.x + box.width * randomFloat(0.3, 0.7);
    const clickY = box.y + box.height * randomFloat(0.3, 0.7);

    await humanClick(page, clickX, clickY);
    return true;
  } catch (error: any) {
    logger.error(`[HumanBehavior] Click element failed: ${error.message}`);
    return false;
  }
}

// ============================================================================
// HUMAN-LIKE TYPING
// ============================================================================

/**
 * Character typing speed based on keyboard layout
 * Some keys are faster to type than others
 */
function getKeyDelay(char: string, prevChar: string): number {
  const baseDelay = randomInt(50, 150);

  // Same hand sequences are faster
  const leftHand = 'qwertasdfgzxcvb';
  const rightHand = 'yuiophjklnm';

  const prevLeft = leftHand.includes(prevChar.toLowerCase());
  const currLeft = leftHand.includes(char.toLowerCase());

  if (prevLeft !== currLeft) {
    // Alternating hands is faster
    return baseDelay * 0.8;
  }

  // Special characters are slower
  if (/[!@#$%^&*()_+{}|:"<>?]/.test(char)) {
    return baseDelay * 1.5;
  }

  // Numbers are slightly slower
  if (/[0-9]/.test(char)) {
    return baseDelay * 1.2;
  }

  // Space after word is fast
  if (char === ' ') {
    return baseDelay * 0.7;
  }

  return baseDelay;
}

/**
 * Human-like typing with variable speed and occasional typos
 */
export async function humanType(page: Page, text: string, options?: {
  selector?: string;
  typoRate?: number; // Probability of typo (0-1), default 0.02
  fixTypos?: boolean; // Whether to fix typos, default true
}): Promise<void> {
  const { selector, typoRate = 0.02, fixTypos = true } = options || {};

  // Focus on element if selector provided
  if (selector) {
    await humanClickElement(page, selector);
    await shortPause();
  }

  let prevChar = '';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Simulate typo
    if (Math.random() < typoRate && fixTypos) {
      // Type wrong character
      const typoChar = getAdjacentKey(char);
      await page.keyboard.type(typoChar);
      await humanDelay(randomInt(100, 300));

      // Pause (notice mistake)
      await humanDelay(randomInt(200, 500));

      // Backspace to fix
      await page.keyboard.press('Backspace');
      await humanDelay(randomInt(50, 150));
    }

    // Type correct character
    const delay = getKeyDelay(char, prevChar);
    await page.keyboard.type(char, { delay });

    // Occasional pause mid-typing (thinking)
    if (Math.random() < 0.05 && char === ' ') {
      await humanDelay(randomInt(200, 800));
    }

    prevChar = char;
  }

  logger.debug(`[HumanBehavior] Typed ${text.length} characters`);
}

/**
 * Get adjacent key for typo simulation
 */
function getAdjacentKey(char: string): string {
  const keyboard: { [key: string]: string[] } = {
    'q': ['w', 'a'], 'w': ['q', 'e', 's'], 'e': ['w', 'r', 'd'],
    'r': ['e', 't', 'f'], 't': ['r', 'y', 'g'], 'y': ['t', 'u', 'h'],
    'u': ['y', 'i', 'j'], 'i': ['u', 'o', 'k'], 'o': ['i', 'p', 'l'],
    'p': ['o', 'l'], 'a': ['q', 's', 'z'], 's': ['a', 'd', 'w', 'x'],
    'd': ['s', 'f', 'e', 'c'], 'f': ['d', 'g', 'r', 'v'],
    'g': ['f', 'h', 't', 'b'], 'h': ['g', 'j', 'y', 'n'],
    'j': ['h', 'k', 'u', 'm'], 'k': ['j', 'l', 'i'],
    'l': ['k', 'o', 'p'], 'z': ['a', 'x'], 'x': ['z', 'c', 's'],
    'c': ['x', 'v', 'd'], 'v': ['c', 'b', 'f'], 'b': ['v', 'n', 'g'],
    'n': ['b', 'm', 'h'], 'm': ['n', 'j', 'k'],
  };

  const lowerChar = char.toLowerCase();
  const adjacent = keyboard[lowerChar];

  if (adjacent && adjacent.length > 0) {
    const typo = adjacent[randomInt(0, adjacent.length - 1)];
    return char === char.toUpperCase() ? typo.toUpperCase() : typo;
  }

  return char;
}

// ============================================================================
// HUMAN-LIKE SCROLLING
// ============================================================================

/**
 * Human-like scroll with variable speed and occasional pauses
 */
export async function humanScroll(page: Page, options?: {
  direction?: 'down' | 'up';
  distance?: number; // Total scroll distance
  readContent?: boolean; // Pause to "read" content
}): Promise<void> {
  const { direction = 'down', distance = 800, readContent = true } = options || {};

  const scrollDir = direction === 'down' ? 1 : -1;
  let scrolled = 0;

  while (scrolled < distance) {
    // Variable scroll amount (like mouse wheel increments)
    const scrollAmount = randomInt(80, 200) * scrollDir;

    await page.mouse.wheel(0, scrollAmount);
    scrolled += Math.abs(scrollAmount);

    // Variable delay between scrolls
    await humanDelay(randomInt(50, 200));

    // Occasionally pause to "read" content
    if (readContent && Math.random() < 0.2) {
      await humanDelay(randomInt(500, 2000));
    }
  }

  logger.debug(`[HumanBehavior] Scrolled ${direction} ${distance}px`);
}

/**
 * Scroll to element with human-like behavior
 */
export async function humanScrollToElement(page: Page, selector: string): Promise<boolean> {
  try {
    const element = await page.$(selector);
    if (!element) return false;

    // Scroll element into view with smooth behavior
    await element.scrollIntoViewIfNeeded();

    // Add natural pause after scrolling
    await humanDelay(randomInt(200, 500));

    return true;
  } catch (error: any) {
    logger.error(`[HumanBehavior] Scroll to element failed: ${error.message}`);
    return false;
  }
}

// ============================================================================
// BEHAVIOR PATTERNS
// ============================================================================

/**
 * Simulate reading behavior (scrolling + pausing)
 */
export async function simulateReading(page: Page, duration: number = 5000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < duration) {
    // Random action: scroll, pause, or move mouse
    const action = Math.random();

    if (action < 0.4) {
      // Scroll down slightly
      await humanScroll(page, { direction: 'down', distance: randomInt(100, 300), readContent: true });
    } else if (action < 0.7) {
      // Just pause (reading)
      await humanDelay(randomInt(1000, 3000));
    } else {
      // Move mouse around (looking at different areas)
      const viewport = page.viewportSize() || { width: 1920, height: 1080 };
      await humanMouseMove(
        page,
        randomInt(100, viewport.width - 100),
        randomInt(100, viewport.height - 100)
      );
      await shortPause();
    }
  }

  logger.debug(`[HumanBehavior] Simulated reading for ${duration}ms`);
}

/**
 * Simulate browsing Facebook feed
 */
export async function simulateFacebookBrowsing(page: Page, options?: {
  postsToView?: number;
  interactionRate?: number; // Probability of interacting with post (0-1)
}): Promise<{ postsViewed: number; interactions: number }> {
  const { postsToView = 10, interactionRate = 0.1 } = options || {};

  let postsViewed = 0;
  let interactions = 0;

  for (let i = 0; i < postsToView; i++) {
    // Scroll to load more content
    await humanScroll(page, { direction: 'down', distance: randomInt(300, 600), readContent: true });

    // "Read" the post
    await humanDelay(randomInt(2000, 5000));

    // Occasionally interact
    if (Math.random() < interactionRate) {
      // Try to find and click like button (simplified)
      const likeClicked = await humanClickElement(page, '[aria-label*="Like"], [aria-label*="Thích"]');
      if (likeClicked) {
        interactions++;
        await shortPause();
      }
    }

    postsViewed++;

    // Occasional longer pause (distraction simulation)
    if (Math.random() < 0.1) {
      await longPause();
    }
  }

  logger.info(`[HumanBehavior] Browsed ${postsViewed} posts, ${interactions} interactions`);
  return { postsViewed, interactions };
}

// ============================================================================
// STEALTH CONFIGURATION
// ============================================================================

/**
 * Apply comprehensive stealth settings to page context
 * Based on:
 * - puppeteer-extra-plugin-stealth
 * - rebrowser-patches
 * - fingerprint-suite
 *
 * Protects against:
 * - navigator.webdriver detection
 * - CDP Runtime.enable detection
 * - Canvas fingerprinting
 * - WebGL fingerprinting
 * - AudioContext fingerprinting
 * - Playwright global variable detection
 *
 * @param page - Playwright page
 * @param languages - Optional language array (auto-detected if not provided)
 */
export async function applyStealthSettings(page: Page, languages?: string[]): Promise<void> {
  // Get languages from location profile if not provided
  const langs = languages || getLocationProfile().languages;

  // Generate consistent noise seed for this session (so fingerprint is stable within session)
  const noiseSeed = Math.random() * 1000;

  try {
    // Remove webdriver property and apply comprehensive stealth
    await page.addInitScript((args: { languageList: string[]; seed: number }) => {
      const { languageList, seed } = args;

      // Seeded random for consistent fingerprint noise
      const seededRandom = (s: number) => {
        const x = Math.sin(s++) * 10000;
        return x - Math.floor(x);
      };

      // ============================================
      // 1. NAVIGATOR PATCHES
      // ============================================

      // Remove webdriver property
      // @ts-ignore
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // Fake plugins array
      // @ts-ignore
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
        ],
      });

      // Use detected languages
      // @ts-ignore
      Object.defineProperty(navigator, 'languages', {
        get: () => languageList,
      });

      // Fake hardware concurrency (realistic range)
      const cores = [2, 4, 6, 8, 12, 16][Math.floor(seededRandom(seed) * 6)];
      // @ts-ignore
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => cores,
      });

      // Fake device memory (realistic values)
      const memory = [2, 4, 8, 16][Math.floor(seededRandom(seed + 1) * 4)];
      // @ts-ignore
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => memory,
      });

      // ============================================
      // 2. CANVAS FINGERPRINT NOISE
      // ============================================

      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;

      // Add noise to canvas toDataURL
      HTMLCanvasElement.prototype.toDataURL = function(type?: string, quality?: any) {
        const ctx = this.getContext('2d');
        if (ctx) {
          // Add imperceptible noise to canvas
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            // Add tiny noise to RGB values (not alpha)
            const noise = Math.floor(seededRandom(seed + i) * 3) - 1; // -1, 0, or 1
            imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + noise));
          }
          ctx.putImageData(imageData, 0, 0);
        }
        return originalToDataURL.apply(this, [type, quality]);
      };

      // Add noise to getImageData
      CanvasRenderingContext2D.prototype.getImageData = function(sx: number, sy: number, sw: number, sh: number) {
        const imageData = originalGetImageData.apply(this, [sx, sy, sw, sh]);
        for (let i = 0; i < imageData.data.length; i += 4) {
          const noise = Math.floor(seededRandom(seed + i + 1000) * 3) - 1;
          imageData.data[i] = Math.max(0, Math.min(255, imageData.data[i] + noise));
        }
        return imageData;
      };

      // ============================================
      // 3. WEBGL FINGERPRINT NOISE
      // ============================================

      const getParameterProxyHandler = {
        apply: function(target: any, thisArg: any, args: any[]) {
          const param = args[0];
          const result = target.apply(thisArg, args);

          // Add noise to certain WebGL parameters
          if (param === 37445) { // UNMASKED_VENDOR_WEBGL
            return 'Google Inc. (NVIDIA)';
          }
          if (param === 37446) { // UNMASKED_RENDERER_WEBGL
            const renderers = [
              'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0)',
              'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)',
              'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)',
              'ANGLE (AMD, AMD Radeon RX 580 Series Direct3D11 vs_5_0 ps_5_0)',
            ];
            return renderers[Math.floor(seededRandom(seed + 2) * renderers.length)];
          }
          return result;
        },
      };

      // Patch WebGL
      const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = new Proxy(originalGetParameter, getParameterProxyHandler);

      // Patch WebGL2
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const originalGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = new Proxy(originalGetParameter2, getParameterProxyHandler);
      }

      // ============================================
      // 4. AUDIO CONTEXT FINGERPRINT NOISE
      // ============================================

      const originalGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = function(channel: number) {
        const data = originalGetChannelData.apply(this, [channel]);
        // Add tiny noise to audio data
        for (let i = 0; i < data.length; i += 100) {
          data[i] = data[i] + (seededRandom(seed + i + 2000) * 0.0001 - 0.00005);
        }
        return data;
      };

      // ============================================
      // 5. REMOVE PLAYWRIGHT DETECTION
      // ============================================

      // Remove Playwright globals
      // @ts-ignore
      delete window.__playwright__;
      // @ts-ignore
      delete window.__pwInitScripts;
      // @ts-ignore
      delete window.__playwright__binding__;

      // ============================================
      // 6. CHROME OBJECT & PERMISSIONS
      // ============================================

      // Hide automation - create realistic chrome object
      // @ts-ignore
      window.chrome = {
        runtime: {
          connect: () => {},
          sendMessage: () => {},
          onMessage: { addListener: () => {} },
        },
        loadTimes: () => ({
          commitLoadTime: Date.now() / 1000 - 5,
          connectionInfo: 'http/1.1',
          finishDocumentLoadTime: Date.now() / 1000 - 0.5,
          finishLoadTime: Date.now() / 1000 - 0.3,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000 - 4,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'unknown',
          requestTime: Date.now() / 1000 - 6,
          startLoadTime: Date.now() / 1000 - 5,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: false,
          wasNpnNegotiated: false,
        }),
        csi: () => ({
          onloadT: Date.now() - 300,
          pageT: Date.now() - 500,
          startE: Date.now() - 600,
          tran: 15,
        }),
      };

      // Override permissions
      const originalQuery = window.navigator.permissions.query;
      // @ts-ignore
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          // @ts-ignore
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery.call(navigator.permissions, parameters);

      // ============================================
      // 7. NETWORK & MISC
      // ============================================

      // Fake connection type
      // @ts-ignore
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          rtt: 50 + Math.floor(seededRandom(seed + 3) * 50), // Slight variation
          downlink: 8 + Math.floor(seededRandom(seed + 4) * 4),
          saveData: false,
        }),
      });

      // Fake battery status (to avoid empty battery detection)
      // @ts-ignore
      navigator.getBattery = async () => ({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 0.85 + seededRandom(seed + 5) * 0.15,
        addEventListener: () => {},
        removeEventListener: () => {},
      });

      // ============================================
      // 8. CONSOLE LOG TRAP (CDP Detection)
      // ============================================

      // Prevent CDP Runtime.consoleAPICalled detection
      const originalConsoleLog = console.log;
      const originalConsoleWarn = console.warn;
      const originalConsoleError = console.error;

      // Wrap console methods to avoid CDP detection
      console.log = function(...args: any[]) {
        // Filter out automation-related logs
        const msg = args.join(' ');
        if (msg.includes('DevTools') || msg.includes('puppeteer') || msg.includes('playwright')) {
          return;
        }
        return originalConsoleLog.apply(console, args);
      };

    }, { languageList: langs, seed: noiseSeed });

    logger.info(`[HumanBehavior] Comprehensive stealth settings applied`);
    logger.info(`[HumanBehavior] Languages: ${langs.join(', ')}`);
    logger.info(`[HumanBehavior] Protections: webdriver, canvas, WebGL, AudioContext, Playwright globals`);
  } catch (error: any) {
    logger.warn(`[HumanBehavior] Failed to apply stealth settings: ${error.message}`);
  }
}

/**
 * Get random realistic viewport size
 */
export function getRealisticViewport(): { width: number; height: number } {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
  ];

  return viewports[randomInt(0, viewports.length - 1)];
}

/**
 * Get random realistic user agent
 */
export function getRealisticUserAgent(): string {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ];

  return userAgents[randomInt(0, userAgents.length - 1)];
}

// ============================================================================
// LOCALE & GEOLOCATION DETECTION
// ============================================================================

/**
 * Location profiles for different countries
 */
export interface LocationProfile {
  locale: string;
  languages: string[];
  timezoneId: string;
  geolocation: { latitude: number; longitude: number };
  city: string;
  country: string;
}

const LOCATION_PROFILES: Record<string, LocationProfile> = {
  'PL': {
    locale: 'pl-PL',
    languages: ['pl-PL', 'pl', 'en-US', 'en'],
    timezoneId: 'Europe/Warsaw',
    geolocation: { latitude: 52.2297, longitude: 21.0122 }, // Warsaw
    city: 'Warsaw',
    country: 'Poland',
  },
  'VN': {
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi', 'en-US', 'en'],
    timezoneId: 'Asia/Ho_Chi_Minh',
    geolocation: { latitude: 10.8231, longitude: 106.6297 }, // Ho Chi Minh City
    city: 'Ho Chi Minh City',
    country: 'Vietnam',
  },
  'US': {
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 }, // New York
    city: 'New York',
    country: 'USA',
  },
  'DE': {
    locale: 'de-DE',
    languages: ['de-DE', 'de', 'en-US', 'en'],
    timezoneId: 'Europe/Berlin',
    geolocation: { latitude: 52.5200, longitude: 13.4050 }, // Berlin
    city: 'Berlin',
    country: 'Germany',
  },
  'GB': {
    locale: 'en-GB',
    languages: ['en-GB', 'en'],
    timezoneId: 'Europe/London',
    geolocation: { latitude: 51.5074, longitude: -0.1278 }, // London
    city: 'London',
    country: 'UK',
  },
  'FR': {
    locale: 'fr-FR',
    languages: ['fr-FR', 'fr', 'en-US', 'en'],
    timezoneId: 'Europe/Paris',
    geolocation: { latitude: 48.8566, longitude: 2.3522 }, // Paris
    city: 'Paris',
    country: 'France',
  },
  'TR': {
    locale: 'tr-TR',
    languages: ['tr-TR', 'tr', 'en-US', 'en'],
    timezoneId: 'Europe/Istanbul',
    geolocation: { latitude: 41.0082, longitude: 28.9784 }, // Istanbul
    city: 'Istanbul',
    country: 'Turkey',
  },
  'UA': {
    locale: 'uk-UA',
    languages: ['uk-UA', 'uk', 'ru-RU', 'en-US', 'en'],
    timezoneId: 'Europe/Kiev',
    geolocation: { latitude: 50.4501, longitude: 30.5234 }, // Kyiv
    city: 'Kyiv',
    country: 'Ukraine',
  },
  'RU': {
    locale: 'ru-RU',
    languages: ['ru-RU', 'ru', 'en-US', 'en'],
    timezoneId: 'Europe/Moscow',
    geolocation: { latitude: 55.7558, longitude: 37.6173 }, // Moscow
    city: 'Moscow',
    country: 'Russia',
  },
  'CN': {
    locale: 'zh-CN',
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    timezoneId: 'Asia/Shanghai',
    geolocation: { latitude: 31.2304, longitude: 121.4737 }, // Shanghai
    city: 'Shanghai',
    country: 'China',
  },
};

/**
 * Auto-detect country from system timezone
 */
export function detectCountryFromTimezone(): string {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    logger.debug(`[HumanBehavior] Detected timezone: ${timezone}`);

    // Map timezone to country code
    const timezoneToCountry: Record<string, string> = {
      'Europe/Warsaw': 'PL',
      'Europe/Berlin': 'DE',
      'Europe/London': 'GB',
      'Europe/Paris': 'FR',
      'Europe/Istanbul': 'TR',
      'Europe/Kiev': 'UA',
      'Europe/Moscow': 'RU',
      'Asia/Ho_Chi_Minh': 'VN',
      'Asia/Saigon': 'VN',
      'Asia/Shanghai': 'CN',
      'Asia/Beijing': 'CN',
      'America/New_York': 'US',
      'America/Los_Angeles': 'US',
      'America/Chicago': 'US',
    };

    for (const [tz, country] of Object.entries(timezoneToCountry)) {
      if (timezone.includes(tz.split('/')[1]) || timezone === tz) {
        return country;
      }
    }

    // Default based on timezone continent
    if (timezone.startsWith('Europe/')) return 'DE';
    if (timezone.startsWith('Asia/')) return 'VN';
    if (timezone.startsWith('America/')) return 'US';

    return 'US'; // Fallback
  } catch {
    return 'US';
  }
}

/**
 * Get location profile for a country (auto-detect if not specified)
 */
export function getLocationProfile(countryCode?: string): LocationProfile {
  const code = countryCode?.toUpperCase() || detectCountryFromTimezone();
  const profile = LOCATION_PROFILES[code] || LOCATION_PROFILES['US'];

  logger.info(`[HumanBehavior] Using location profile: ${profile.city}, ${profile.country}`);
  return profile;
}

/**
 * Get system locale
 */
export function getSystemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

/**
 * Get system timezone
 */
export function getSystemTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// ============================================================================
// RATE LIMITING & ACTION THROTTLING
// ============================================================================

/**
 * Action rate limiter to prevent suspicious activity patterns
 */
class ActionRateLimiter {
  private actions: Map<string, number[]> = new Map();
  private limits: Map<string, { maxActions: number; windowMs: number }> = new Map([
    ['like', { maxActions: 10, windowMs: 60000 }],      // 10 likes per minute
    ['comment', { maxActions: 5, windowMs: 60000 }],    // 5 comments per minute
    ['scroll', { maxActions: 30, windowMs: 60000 }],    // 30 scrolls per minute
    ['click', { maxActions: 20, windowMs: 60000 }],     // 20 clicks per minute
    ['type', { maxActions: 10, windowMs: 60000 }],      // 10 type actions per minute
    ['navigate', { maxActions: 10, windowMs: 60000 }],  // 10 navigations per minute
  ]);

  /**
   * Check if action is allowed
   */
  canPerform(actionType: string): boolean {
    const limit = this.limits.get(actionType);
    if (!limit) return true;

    const now = Date.now();
    const timestamps = this.actions.get(actionType) || [];

    // Remove old timestamps outside window
    const validTimestamps = timestamps.filter(t => now - t < limit.windowMs);
    this.actions.set(actionType, validTimestamps);

    return validTimestamps.length < limit.maxActions;
  }

  /**
   * Record an action
   */
  record(actionType: string): void {
    const timestamps = this.actions.get(actionType) || [];
    timestamps.push(Date.now());
    this.actions.set(actionType, timestamps);
  }

  /**
   * Get wait time until next action is allowed
   */
  getWaitTime(actionType: string): number {
    const limit = this.limits.get(actionType);
    if (!limit) return 0;

    const timestamps = this.actions.get(actionType) || [];
    if (timestamps.length < limit.maxActions) return 0;

    const oldestInWindow = timestamps[timestamps.length - limit.maxActions];
    const waitUntil = oldestInWindow + limit.windowMs;
    return Math.max(0, waitUntil - Date.now());
  }

  /**
   * Wait until action is allowed
   */
  async waitForAction(actionType: string): Promise<void> {
    const waitTime = this.getWaitTime(actionType);
    if (waitTime > 0) {
      logger.info(`[RateLimiter] Waiting ${waitTime}ms before ${actionType} action`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }

  /**
   * Set custom limit for action type
   */
  setLimit(actionType: string, maxActions: number, windowMs: number): void {
    this.limits.set(actionType, { maxActions, windowMs });
  }

  /**
   * Clear all recorded actions
   */
  clear(): void {
    this.actions.clear();
  }
}

// Global rate limiter instance
export const rateLimiter = new ActionRateLimiter();

/**
 * Rate-limited action wrapper
 */
export async function rateLimitedAction<T>(
  actionType: string,
  action: () => Promise<T>
): Promise<T> {
  await rateLimiter.waitForAction(actionType);

  if (!rateLimiter.canPerform(actionType)) {
    logger.warn(`[RateLimiter] Action ${actionType} blocked due to rate limit`);
    throw new Error(`Rate limit exceeded for ${actionType}. Please wait.`);
  }

  rateLimiter.record(actionType);
  return action();
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Session activity tracker to maintain realistic browsing patterns
 */
class SessionTracker {
  private sessionStart: number = Date.now();
  private lastActivity: number = Date.now();
  private totalActions: number = 0;
  private sessionId: string = Math.random().toString(36).substring(7);

  /**
   * Record activity
   */
  recordActivity(): void {
    this.lastActivity = Date.now();
    this.totalActions++;
  }

  /**
   * Get session duration in minutes
   */
  getSessionDuration(): number {
    return (Date.now() - this.sessionStart) / 60000;
  }

  /**
   * Get idle time in seconds
   */
  getIdleTime(): number {
    return (Date.now() - this.lastActivity) / 1000;
  }

  /**
   * Check if session is too long (suggests taking a break)
   */
  shouldTakeBreak(): boolean {
    // Take break after 30 minutes or 100 actions
    return this.getSessionDuration() > 30 || this.totalActions > 100;
  }

  /**
   * Check if session seems suspicious (too active)
   */
  isSuspiciouslyActive(): boolean {
    const actionsPerMinute = this.totalActions / Math.max(1, this.getSessionDuration());
    // More than 20 actions per minute is suspicious
    return actionsPerMinute > 20;
  }

  /**
   * Reset session
   */
  reset(): void {
    this.sessionStart = Date.now();
    this.lastActivity = Date.now();
    this.totalActions = 0;
    this.sessionId = Math.random().toString(36).substring(7);
  }

  /**
   * Get session stats
   */
  getStats(): { duration: number; actions: number; actionsPerMinute: number } {
    const duration = this.getSessionDuration();
    return {
      duration,
      actions: this.totalActions,
      actionsPerMinute: this.totalActions / Math.max(1, duration),
    };
  }
}

// Global session tracker
export const sessionTracker = new SessionTracker();

/**
 * Safe action wrapper that respects rate limits and session health
 */
export async function safeAction<T>(
  actionType: string,
  action: () => Promise<T>,
  options?: { skipRateLimit?: boolean; logActivity?: boolean }
): Promise<T> {
  const { skipRateLimit = false, logActivity = true } = options || {};

  // Check session health
  if (sessionTracker.isSuspiciouslyActive()) {
    logger.warn('[Session] Activity seems suspicious, adding cooldown');
    await humanDelay(5000, 0.5);
  }

  // Apply rate limiting
  if (!skipRateLimit) {
    await rateLimiter.waitForAction(actionType);
    rateLimiter.record(actionType);
  }

  // Execute action
  const result = await action();

  // Record activity
  if (logActivity) {
    sessionTracker.recordActivity();
  }

  // Suggest break if needed
  if (sessionTracker.shouldTakeBreak()) {
    logger.info('[Session] Long session detected, consider taking a break');
  }

  return result;
}

// ============================================================================
// BROWSER LAUNCH ARGS (Anti-Detection)
// ============================================================================

/**
 * Get Chrome launch args for anti-detection
 */
export function getStealthLaunchArgs(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', // Critical: hide automation
    '--disable-infobars',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-component-extensions-with-background-pages',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    '--window-size=1920,1080',
    // Exclude known automation-detection flags
    '--excludeSwitches=enable-automation',
  ];
}

logger.info('[HumanBehavior] Module loaded - Comprehensive anti-detection ready');
