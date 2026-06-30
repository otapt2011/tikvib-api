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
app.get('/api/media/:mediaId', async (req, res) => {
  const { mediaId } = req.params;

  try {
    const url = `https://www.tikvib.com/media/${mediaId}`;
    const html = await fetchPageWithBrowserless(url);

    if (html.includes('Page not found') || html.includes('Error 404')) {
      return res.status(404).json({ error: 'Media not found' });
    }

    const $ = cheerio.load(html);

    // --- Video details ---
    const title = $('.media-title, .video-title, h1').first().text().trim() || null;
    const videoSrc = $('video source').attr('src')
                      || $('.video-player video').attr('src')
                      || $('meta[property="og:video"]').attr('content')
                      || null;

    // Download links (often inside .download-block or data-source attributes)
    const downloadVideo = $('.download-block a[download]').first().attr('href')
                          || $('.download-btn[data-type="video"]').attr('data-source')
                          || null;
    const downloadMusic = $('.download-block a.download-music').attr('href')
                          || $('.download-btn[data-type="music"]').attr('data-source')
                          || null;

    // Stats (may be in a table or data attributes)
    const likes = $('.stat-likes, [data-stat="likes"]').text().trim()
                  || $('[property="og:description"]').attr('content')?.match(/(\d+)\s*likes/i)?.[1]
                  || null;
    const views = $('.stat-views, [data-stat="views"]').text().trim() || null;
    const comments = $('.stat-comments, [data-stat="comments"]').text().trim() || null;

    // Author info
    const authorName = $('.media-author a, .author-name').first().text().trim() || null;
    const authorLink = $('.media-author a, .author-name').first().attr('href') || null;

    // Description (often from meta tag)
    const description = $('meta[name="description"]').attr('content')?.trim() || null;

    res.json({
      mediaId,
      title,
      description,
      videoSrc,          // direct .mp4 URL (may expire)
      download: {
        video: downloadVideo,
        music: downloadMusic,
      },
      stats: {
        likes,
        views,
        comments,
      },
      author: {
        name: authorName,
        link: authorLink ? `https://www.tikvib.com${authorLink}` : null,
      },
      page: 1,           // media pages are single
    });
  } catch (error) {
    console.error('Media scrape error:', error.message);
    res.status(500).json({ error: 'Failed to fetch media data' });
  }
});

app.get('/', (_, res) => res.send('TikVib Proxy API'));
module.exports = app;
