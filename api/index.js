const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Simple in‑memory cache (5 min TTL)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Fetch fully rendered HTML via browserless.io
 * Requires BROWSERLESS_API_KEY in Vercel environment variables.
 */
async function fetchPageWithBrowserless(url) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const response = await axios.post(
    `https://chrome.browserless.io/content?token=${apiKey}`,
    {
      url,
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

  return response.data;
}

/**
 * Scrape profile + videos from TikVib HTML.
 */
function scrapeProfile(html, username) {
  const $ = cheerio.load(html);
  const profile = { username };
  const videos = [];

  // --- Profile ---
  // Avatar: <img class="profile-image" ...>
  profile.avatar = $('img.profile-image').first().attr('src') || null;

  // Display name: TikVib uses just @username in h5.username – fallback to username
  const nameText = $('h5.username').first().text().trim();
  profile.displayName = nameText.replace(/^@/, '') || username;

  // Bio – not visible in snippet, keep fallback selectors
  profile.bio = $('.profile-bio, .user-bio, .description').first().text().trim() || null;

  // Stats
  const stats = {};
  $('.profile-stats .profile-stat-item').each((i, el) => {
    const label = $(el).find('.profile-stat-label').text().trim().toLowerCase();
    const value = $(el).find('.profile-stat-number').text().trim();
    if (label === 'posts') stats.posts = value;
    else if (label === 'followers') stats.followers = value;
    else if (label === 'following') stats.following = value;
    else if (label === 'likes') stats.likes = value;
  });
  profile.stats = stats;

  // --- Videos ---
  $('.posts__video-item').each((i, el) => {
    const $el = $(el);
    const linkEl = $el.find('a.posts__video-item-a');
    const imgEl = linkEl.find('img');
    const infoEl = $el.find('.posts__video-item-story-info');

    const link = linkEl.attr('href') || null;
    const thumbnail = imgEl.attr('src') || null;
    const title = imgEl.attr('alt') || null;

    // Data attributes hold real stats
    const likes = infoEl.attr('data-likes') || null;
    const views = infoEl.attr('data-views') || null;
    const comments = infoEl.attr('data-comments') || null;
    const shares = infoEl.attr('data-shares') || null;
    const time = infoEl.attr('data-time') || null;

    videos.push({
      id: link ? link.split('/').pop() : i,
      title,
      thumbnail,
      link: link ? `https://www.tikvib.com${link}` : null,
      stats: {
        likes,
        views,
        comments,
        shares,
      },
      posted: time,
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
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Failed to fetch profile data' });
  }
});

// Health check
app.get('/', (_, res) => res.send('TikVib Proxy API (browserless.io)'));

module.exports = app;
