# TikVib Proxy API

Scrapes public TikTok profile data from tikvib.com using browserless.io.

## Setup

1. Get a free API key at [browserless.io](https://www.browserless.io/)
2. Add it as `BROWSERLESS_API_KEY` in Vercel environment variables
3. Deploy to Vercel

## Usage

`GET https://tikvib-api.vercel.app/api/profile/jafernegery`

Optional: `?page=2` (only for page > 1)
