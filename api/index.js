const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Simple in-memory cache (TTL 5 minutes)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Fetch a page with browser-like headers
 */
async function fetchPage(url) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      Referer: 'https://www.tikvib.com/',
      DNT: '1',
    },
    timeout: 10000,
  });
  return data;
}

/**
 * Scrape profile + videos from TikVib HTML
 */
function scrapeProfile(html, username) {
  const $ = cheerio.load(html);
  const profile = {};
  const videos = [];

  // --- Profile data ---
  profile.username = username;
  profile.avatar = $('img.profile-avatar, .avatar-img').first().attr('src') || null;
  profile.displayName =
    $('.profile-nickname, .profile-display-name, h1.profile-name')
      .first()
      .text()
      .trim() || null;
  profile.bio =
    $('.profile-bio, .user-bio, p.bio').first().text().trim() || null;

  // Stats
  const stats = {};
  $('.profile-stat-item, .stat-item').each((i, el) => {
    const label = $(el).find('.stat-label').text().trim().toLowerCase();
    const value = $(el).find('.stat-number').text().trim();
    if (label.includes('followers')) stats.followers = value;
    else if (label.includes('following')) stats.following = value;
    else if (label.includes('likes')) stats.likes = value;
  });
  // Fallback: try text‑based extraction
  if (!stats.followers) {
    const followerEl = $('*')
      .filter((i, el) => $(el).text().includes('Followers'))
      .first();
    if (followerEl.length) {
      const text = followerEl.text();
      const match = text.match(/([\d,.KMB]+)\s*Followers/);
      if (match) stats.followers = match[1];
    }
  }
  profile.stats = stats;

  // --- Videos ---
  $('.video-feed-item, .video-card, .video-item').each((i, el) => {
    const $el = $(el);
    const thumbnail = $el.find('img').first().attr('src') || null;
    const link = $el.find('a').first().attr('href') || null;
    const views = $el.find('.video-views, .view-count').text().trim() || null;
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
// DEBUG: expose raw response (temporary – remove after test)
app.get('/debug/profile/:username', async (req, res) => {
  const { username } = req.params;
  const page = req.query.page || 1;
  try {
    const url = `https://www.tikvib.com/profile/${username}?page=${page}`;
    const html = await fetchPage(url);
    res.set('Content-Type', 'text/plain');
    res.send(`STATUS: 200\nURL: ${url}\n\n${html.substring(0, 2000)}`);
  } catch (error) {
    res.json({
      error: error.message,
      status: error.response?.status,
      headers: error.response?.headers,
    });
  }
});
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
    const html = await fetchPage(url);

    if (
      html.includes('Profile not found') ||
      html.includes('User not found')
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

    // Store in cache
    cache.set(cacheKey, {
      timestamp: Date.now(),
      data: responseData,
    });

    // Keep cache size under control
    if (cache.size > 100) {
      const oldest = [...cache.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp
      )[0];
      cache.delete(oldest[0]);
    }

    res.json(responseData);
  } catch (error) {
    console.error(`Error scraping ${username}:`, error.message);
    if (error.response && error.response.status === 404) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.status(500).json({ error: 'Failed to fetch profile data' });
  }
});

// Health check
app.get('/', (req, res) => {
  res.send('TikVib Proxy API is running. Use /api/profile/:username');
});

// Vercel serverless export
module.exports = app;
