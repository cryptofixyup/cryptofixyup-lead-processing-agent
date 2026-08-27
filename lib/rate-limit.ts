const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 10;
const KEY_PREFIX = 'lead-agent:rate:';
const REQUEST_TIMEOUT_MS = 3000;

function getConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('Upstash Redis is required for rate limiting.');
  }

  return { url: url.replace(/\/$/, ''), token };
}

async function command<T>(args: unknown[]): Promise<T> {
  const { url, token } = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: controller.signal
    });

    const payload = (await response.json()) as { result?: T; error?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Redis request failed (${response.status}).`);
    }

    return payload.result as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export async function getClientKey(request: Request): Promise<string> {
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const candidate = forwarded?.split(',')[0]?.trim() || realIp?.trim() || 'unknown';

  return sha256(candidate);
}

export async function checkLeadRateLimit(clientKey: string): Promise<{
  allowed: boolean;
  remaining: number;
}> {
  const bucket = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
  const key = `${KEY_PREFIX}${bucket}:${clientKey}`;
  const count = await command<number>(['INCR', key]);

  if (count === 1) {
    await command<number>(['EXPIRE', key, WINDOW_SECONDS]);
  }

  return {
    allowed: count <= MAX_REQUESTS,
    remaining: Math.max(0, MAX_REQUESTS - count)
  };
}

export const leadRateLimitConfig = {
  windowSeconds: WINDOW_SECONDS,
  maxRequests: MAX_REQUESTS
};
