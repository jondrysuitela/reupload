import { URL } from 'node:url';

export function getAllowedTikTokAccounts(value = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((item) => item.trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
}

export function isTikTokSourceAllowed(username, allowlistInput = []) {
  const normalizedUsername = String(username || '').replace(/^@/, '').toLowerCase();
  const allowed = Array.isArray(allowlistInput)
    ? allowlistInput
    : getAllowedTikTokAccounts(allowlistInput);

  if (allowed.length === 0) return true;
  return allowed.includes(normalizedUsername);
}

export function parseTikTokUrl(urlString) {
  if (!urlString) throw new Error('TikTok URL is required');

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid TikTok URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('TikTok URLs must use HTTPS');
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const allowedHosts = new Set([
    'tiktok.com',
    'm.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
  ]);

  if (!allowedHosts.has(host)) {
    throw new Error('Only TikTok URLs are allowed');
  }

  if (host === 'tiktok.com' || host === 'm.tiktok.com') {
    const match = parsed.pathname.match(/^\/@([^/]+)\/video\/(\d+)/i);
    if (!match) {
      throw new Error('Unsupported TikTok URL format');
    }

    return {
      username: match[1].replace(/^@/, '').toLowerCase(),
      videoId: match[2],
      normalizedUrl: parsed.toString(),
    };
  }

  return {
    username: null,
    videoId: null,
    normalizedUrl: parsed.toString(),
  };
}
