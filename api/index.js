const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Cache: 5 minutes
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Fetch fully rendered HTML via browserless.io
 * Requires BROWSERLESS_API_KEY in Vercel environment variables.
 * Free tier: https://www.browserless.io/ (1000 sessions/month)
 */
async function fetchPageWithBrowserless(url) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const response = await axios.post(
    `https://chrome.browserless.io/content?token=${apiKey}`,
    {
      url,
      waitFor: 3000,               // wait 3 seconds for JavaScript to execute
      rejectResourceTypes: ['image', 'stylesheet', 'font', 'media'], // faster
      gotoOptions: {
        waitUntil: 'networkidle2',
        timeout: 15000,
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );

  return response.data; // raw HTML
}

/**
 * Scrape profile + videos from TikVib HTML.
 * Adjust selectors if fields return null (see notes below).
 */
function scrapeProfile(html, username) {
  const $ = cheerio.load(html);
  const profile = { username };
  const videos = [];

  // Profile
  profile.avatar = $('img.profile-avatar, .avatar-img, img.avatar, .profile-image img').first().attr('src') || null;
  profile.displayName = $('.profile-nickname, .profile-display-name, h1.profile-name, .user-name').first().text().trim() || null;
  profile.bio = $('.profile-bio, .user-bio, p.bio, .description').first().text().trim() || null;

  // Stats
  const stats = {};
  $('.profile-stat-item, .stat-item, .stats-item').each((i, el) => {
    const label = $(el).find('.stat-label, .label').text().trim().toLowerCase();
    const value = $(el).find('.stat-number, .number').text().trim();
    if (label.includes('followers')) stats.followers = value;
    else if (label.includes('following')) stats.following = value;
    else if (label.includes('likes')) stats.likes = value;
  });

  if (!stats.followers) {
    const mF = html.match(/([\d,.KMB]+)\s*Followers/);
    if (mF) stats.followers = mF[1];
    const mFw = html.match(/([\d,.KMB]+)\s*Following/);
    if (mFw) stats.following = mFw[1];
    const mL = html.match(/([\d,.KMB]+)\s*Likes/);
    if (mL) stats.likes = mL[1];
  }
  profile.stats = stats;

  // Videos
  $('.video-feed-item, .video-card, .video-item').each((i, el) => {
    const $el = $(el);
    videos.push({
      id: i,
      thumbnail: $el.find('img').first().attr('src') || null,
      link: $el.find('a').first().attr('href')
        ? `https://www.tikvib.com${$el.find('a').first().attr('href')}`
        : null,
      views: $el.find('.video-views, .view-count, .views').text().trim() || null,
      duration: $el.find('.video-duration, .duration').text().trim() || null,
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
    const html = await fetchPageWithBrowserless(url);

    if (
      html.includes('Profile not found') ||
      html.includes('User not found') ||
      html.includes('Page not found')
    ) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const { profile, videos } = scrapeProfile(html, username);
    const data = { username, ...profile, videos, page };

    cache.set(cacheKey, { timestamp: Date.now(), data });
    res.json(data);
 } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to fetch profile data',
      debug: {
        message: error.message,
        stack: error.stack,
        responseStatus: error.response?.status,
        responseData: error.response?.data?.substring(0, 500) || null,
      },
    });
  }
});

app.get('/', (_, res) => res.send('TikVib Proxy API (browserless.io)'));

module.exports = app;
