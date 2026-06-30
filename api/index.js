const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function fetchPageWithBrowserless(url) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const response = await axios.post(
    `https://chrome.browserless.io/content?token=${apiKey}`,
    {
      url,
      waitForTimeout: 5000,
      gotoOptions: {
        waitUntil: 'networkidle0',
        timeout: 20000,
      },
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 25000,
    }
  );
  return response.data;
}

function scrapeProfile(html, username) {
  const $ = cheerio.load(html);
  const profile = { username };

  profile.avatar = $('img.profile-image').first().attr('src') || null;
  const nameText = $('h5.username').first().text().trim();
  profile.displayName = nameText.replace(/^@/, '') || username;
  profile.bio = $('.profile-bio, .user-bio, .description').first().text().trim() || null;

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

  const videos = [];
  $('.posts__video-item').each((i, el) => {
    const $el = $(el);
    const linkEl = $el.find('a.posts__video-item-a');
    const imgEl = linkEl.find('img');
    const infoEl = $el.find('.posts__video-item-story-info');

    const link = linkEl.attr('href') || null;
    videos.push({
      id: link ? link.split('/').pop() : i,
      title: imgEl.attr('alt') || null,
      thumbnail: imgEl.attr('src') || null,
      link: link ? `https://www.tikvib.com${link}` : null,
      stats: {
        likes: infoEl.attr('data-likes') || null,
        views: infoEl.attr('data-views') || null,
        comments: infoEl.attr('data-comments') || null,
        shares: infoEl.attr('data-shares') || null,
      },
      posted: infoEl.attr('data-time') || null,
    });
  });

  return { profile, videos };
}

app.get('/api/profile/:username', async (req, res) => {
  const { username } = req.params;
  const page = parseInt(req.query.page) || 1;

  if (!username?.trim()) return res.status(400).json({ error: 'Username is required' });

  const cacheKey = `${username}_${page}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    let url = `https://www.tikvib.com/profile/${username}`;
    if (page > 1) url += `?page=${page}`;

    const html = await fetchPageWithBrowserless(url);
    if (html.includes('Error 404') || html.includes('Profile not found')) {
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
// Scrape a single TikTok media (video) page

/**
 * Fetch a media page from TikVib, bypassing Cloudflare.
 * Includes a generic Referer and retries if a challenge is detected.
 */
async function fetchMediaPageWithBrowserless(url) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const makeRequest = async (waitMs = 5000) => {
    const resp = await axios.post(
      `https://chrome.browserless.io/content?token=${apiKey}`,
      {
        url,
        gotoOptions: {
          waitUntil: 'networkidle0',
          timeout: 20000,
        },
        waitForTimeout: waitMs,
        headers: {
          'Referer': 'https://www.tikvib.com/',   // generic – works for any video
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      }
    );
    return resp.data;
  };

  // First attempt
  let html = await makeRequest(5000);

  // If Cloudflare challenge still present, retry with a longer wait
  if (html.includes('Just a moment') || html.includes('Checking your browser')) {
    console.log('Cloudflare detected on media page, retrying…');
    html = await makeRequest(10000);
  }

  return html;
}
// Scrape a single TikTok media (video) page – updated selectors
// Scrape a single TikTok media (video) page – Cloudflare‑proof
app.get('/api/media/:mediaId', async (req, res) => {
  const { mediaId } = req.params;

  try {
    const url = `https://www.tikvib.com/media/${mediaId}`;
    const html = await fetchMediaPageWithBrowserless(url);
    const $ = cheerio.load(html);

    // ── Video source & poster ───────────────────────
    const videoEl = $('video#video').first();
    let videoSrc = videoEl.attr('src');
    if (videoSrc && videoSrc.startsWith('/')) {
      videoSrc = `https://www.tikvib.com${videoSrc}`;
    }
    const poster = videoEl.attr('poster') || null;

    // ── Author ─────────────────────────────────────
    const authorName = $('.video-info-username').first().text().trim() || null;
    const authorLink = $('.video-info-username').first().attr('href') || null;

    // ── Stats ─────────────────────────────────────
    const likes = $('.video-stat-item .video-stat-number').eq(0).text().trim() || null;
    const comments = $('.video-stat-item .video-stat-number').eq(1).text().trim() || null;
    const shares = $('.video-stat-item .video-stat-number').eq(2).text().trim() || null;
    const collections = $('.video-stat-item .video-stat-number').eq(3).text().trim() || null;
    const viewsEl = $('.video-stat-item.views .video-stat-number').first();
    const views = viewsEl.length ? viewsEl.text().trim() : null;

    // ── Download links ─────────────────────────────
    const downloadVideo = $('.download-cards .download-media-button').eq(0).attr('href') || null;
    const downloadMusic = $('.download-cards .download-media-button').eq(1).attr('href') || null;
    const absDownloadVideo = downloadVideo
      ? (downloadVideo.startsWith('http') ? downloadVideo : `https://www.tikvib.com${downloadVideo}`)
      : null;
    const absDownloadMusic = downloadMusic
      ? (downloadMusic.startsWith('http') ? downloadMusic : `https://www.tikvib.com${downloadMusic}`)
      : null;

    res.json({
      mediaId,
      title: $('title').first().text().trim().replace(/\s*-\s*Tikvib.*$/i, '') || null,
      description: $('meta[name="description"]').attr('content')?.trim() || null,
      video: { src: videoSrc, poster },
      download: { video: absDownloadVideo, music: absDownloadMusic },
      stats: { likes, views, comments, shares, collections },
      author: {
        name: authorName,
        link: authorLink ? `https://www.tikvib.com${authorLink}` : null,
      },
    });
  } catch (error) {
    console.error('Media scrape error:', error.message);
    res.status(500).json({ error: 'Failed to fetch media data' });
  }
});

app.get('/', (_, res) => res.send('TikVib Proxy API'));
module.exports = app;
