# Facebook Newsfeed Scraper

## Scripts Available

| Script | Command | Description |
|--------|---------|-------------|
| Basic | `npm run scrape:fb` | Fast scraping, minimal anti-detection |
| **Stealth** | `npm run scrape:fb:stealth` | Full anti-bot bypass (recommended) |
| TypeScript | `npm run scrape:fb:ts` | TypeScript version |

## Anti-Bot Detection Bypass (Stealth Mode)

```
┌─────────────────────────────────────────────────────────────────────┐
│  FACEBOOK ANTI-BOT LAYERS WE BYPASS                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ✅ LAYER 1: BROWSER FINGERPRINTING                                │
│  ├─ navigator.webdriver = undefined (not true)                     │
│  ├─ window.chrome object spoofed                                   │
│  ├─ Plugins array populated (3 fake plugins)                       │
│  ├─ Languages: ['en-US', 'en', 'vi']                              │
│  ├─ Platform: Win32                                                │
│  └─ Real Chrome profile (not headless)                            │
│                                                                     │
│  ✅ LAYER 2: BEHAVIORAL ANALYSIS                                   │
│  ├─ Bezier curve mouse movements (not linear)                     │
│  ├─ Smooth scrolling (5-12 steps, not instant)                    │
│  ├─ Random reading pauses (2-8 seconds)                           │
│  ├─ Variable scroll amounts (300-700px)                           │
│  ├─ Mouse wiggle simulation                                       │
│  └─ Random delays between actions                                 │
│                                                                     │
│  ✅ LAYER 3: NETWORK ANALYSIS                                      │
│  ├─ Uses YOUR real Chrome profile                                 │
│  ├─ YOUR IP address (not datacenter)                              │
│  ├─ Real TLS fingerprint from Chrome                              │
│  └─ Normal request patterns                                       │
│                                                                     │
│  ✅ LAYER 4: ACCOUNT SIGNALS                                       │
│  ├─ YOUR existing account (logged in)                             │
│  ├─ Same device fingerprint as usual                              │
│  └─ Normal activity time (you control)                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Recommended: Stealth mode with full anti-detection
npm run scrape:fb:stealth

# Or basic mode (faster but less safe)
npm run scrape:fb
```

## How It Works

### Mouse Movement (Bezier Curves)

```
Bot movement:        Human movement (our script):

A ─────────── B      A ~~~╮
                          ╰~~╮
(linear, instant)           ╰~~~ B

                     (curved, with small delays)
```

### Scroll Behavior

```
Bot scroll:          Human scroll (our script):

│▼ 600px             │▼ 120px (step 1)
│                    │ wait 50ms
│ instant            │▼ 95px  (step 2)
│                    │ wait 70ms
│                    │▼ 130px (step 3)
│                    │ ...
│                    │▼ 110px (step 8)
```

### Timing Patterns

| Action | Bot | Our Script |
|--------|-----|------------|
| Scroll delay | Fixed 1s | Random 0.8-2.5s |
| Reading pause | None | Random 2-8s (15% chance) |
| Mouse movement | None/linear | Bezier curves |
| Scroll amount | Fixed | Random 300-700px |

## Configuration

Edit `CONFIG.behavior` in `facebook-scraper-stealth.js`:

```javascript
behavior: {
  minScrollDelay: 800,      // ms
  maxScrollDelay: 2500,     // ms
  minScrollAmount: 300,     // px
  maxScrollAmount: 700,     // px
  mouseMovementEnabled: true,
  randomPausesEnabled: true,
  pauseChance: 0.15,        // 15% chance to pause
  minPauseDuration: 2000,   // 2s
  maxPauseDuration: 8000,   // 8s
}
```

## Output

Results saved to `./facebook-scrapes/stealth-scrape-[timestamp].json`:

```json
{
  "scrapedAt": "2026-02-03T...",
  "stealthMode": true,
  "posts": [
    {
      "index": 1,
      "author": "CNN",
      "authorType": "page",
      "timestamp": "2h",
      "content": "Breaking news...",
      "reactions": 1200,
      "comments": 89,
      "shares": 234
    }
  ],
  "summary": "AI summary..."
}
```

## Troubleshooting

### "Account checkpoint required"
- Don't run too frequently (max 2-3x per day)
- Use normal activity times (not 3 AM)
- Make sure account is warmed up

### "Cannot connect to Chrome"
Script auto-launches Chrome. If fails:
```bash
# Manual launch with debugging port
chrome --remote-debugging-port=9222
```

### "No posts found"
- Make sure you're logged into Facebook
- Check if Facebook layout changed
- Try refreshing the page manually first

## Best Practices

1. **Don't scrape too often** - Max 2-3 times per day
2. **Use normal hours** - 9 AM - 11 PM
3. **Don't change settings drastically** - Keep default behavior config
4. **Use your main account** - Old accounts are less suspicious
5. **Mix with real usage** - Use Facebook normally too

## Cost Savings

| Method | Cost per 10 posts |
|--------|-------------------|
| Text scraping | ~$0.002 |
| Vision/screenshots | ~$0.030 |
| **Savings** | **93%** |

## Privacy

- Runs 100% locally
- Uses YOUR logged-in session
- Posts saved locally only
- LLM summary optional (needs OPENAI_API_KEY)
