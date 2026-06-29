const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();

app.use(cors());
app.use(express.json());

// Simple in‑memory cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Let Vercel handle Puppeteer's AWS Lambda Chromium
async function fetchPageWithBrowser(url) {
  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1280, height: 800 },
    executablePath: await chromium.executablePath(),
    headless: true,
  });

  const page = await browser.newPage();
  // Set a realistic user agent (overriding the default Puppeteer one)
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  // Optionally block unnecessary resources to speed up
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
  const html = await page.content();
  await browser.close();
  return html;
}

/**
 * Scrape profile + videos from TikVib HTML
 */
function scrapeProfile(html, username) {
  const $ = cheerio.load(html);
  const profile = {};
  const videos = [];

  profile.username = username;

  // --- Profile selectors ---
  profile.avatar =
    $('img.profile-avatar, .avatar-img, img.avatar').first().attr('src') ||
    null;

  profile.displayName =
    $('.profile-nickname, .profile-display-name, h1.profile-name, .user-name')
      .first()
      .text()
      .trim() || null;

  profile.bio =
    $('.profile-bio, .user-bio, p.bio, .description')
      .first()
      .text()
      .trim() || null;

  // Stats – try common patterns
  const stats = {};
  $('.profile-stat-item, .stat-item, .stats-item').each((i, el) => {
    const label = $(el).find('.stat-label, .label').text().trim().toLowerCase();
    const value = $(el).find('.stat-number, .number').text().trim();
    if (label.includes('followers')) stats.followers = value;
    else if (label.includes('following')) stats.following = value;
    else if (label.includes('likes')) stats.likes = value;
  });

  // Fallback: text search
  if (!stats.followers) {
    const matchFollowers = html.match(/([\d,.KMB]+)\s*Followers/);
    if (matchFollowers) stats.followers = matchFollowers[1];
    const matchFollowing = html.match(/([\d,.KMB]+)\s*Following/);
    if (matchFollowing) stats.following = matchFollowing[1];
    const matchLikes = html.match(/([\d,.KMB]+)\s*Likes/);
    if (matchLikes) stats.likes = matchLikes[1];
  }
  profile.stats = stats;

  // --- Videos ---
  $('.video-feed-item, .video-card, .video-item').each((i, el) => {
    const $el = $(el);
    const thumbnail = $el.find('img').first().attr('src') || null;
    const link = $el.find('a').first().attr('href') || null;
    const views = $el.find('.video-views, .view-count, .views').text().trim() || null;
    const duration =
      $el.find('.video-duration, .duration').text().trim() || null;

    videos.push({
      id: i,
      thumbnail,
      link: link ? `https://www.tikvib.com${link}` : null,
      views,
      duration,
    });
  });

  return { profile, videos };
}

// API endpoint
app.get('/api/profile/:username', async (req, res) => {
  const { username } = req.params;
  const page = req.query.page || 1;

  if (!username || username.trim().length === 0) {
    return res.status(400).json({ error: 'Username is required' });
  }

  const cacheKey = `${username}_${page}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const url = `https://www.tikvib.com/profile/${username}?page=${page}`;
    const html = await fetchPageWithBrowser(url);

    // Check for actual "not found" content
    if (
      html.includes('Profile not found') ||
      html.includes('User not found') ||
      html.includes('Page not found')
    ) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const { profile, videos } = scrapeProfile(html, username);

    const responseData = {
      username,
      ...profile,
      videos,
      page,
    };

    cache.set(cacheKey, { timestamp: Date.now(), data: responseData });

    if (cache.size > 100) {
      const oldest = [...cache.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      )[0];
      cache.delete(oldest[0]);
    }

    res.json(responseData);
} catch (error) {
    console.error(`Error scraping ${username}:`, error);
    // Temporarily return the raw error for debugging
    res.status(500).json({
      error: 'Failed to fetch profile data',
      details: {
        message: error.message,
        stack: error.stack,
        type: error.constructor.name
      }
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('TikVib Proxy API is running with Puppeteer. Use /api/profile/:username');
});

module.exports = app;
