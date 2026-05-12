import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/main/network/auth-refresh', () => ({
  refreshAccessToken: vi.fn(),
  authEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  AUTH_EXPIRED: 'auth-expired',
  AuthRefreshNetworkError: class AuthRefreshNetworkError extends Error {},
}));

import { ApiClient } from '../src/main/network/api-client';

const fetchMock = vi.fn();

function telegramTokenBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    success: true,
    token: 'login-token-1',
    expires_at: '2026-05-12T12:10:00.000Z',
    deep_link: 'https://t.me/ziraai_bot?start=login_login-token-1',
    ...overrides,
  });
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as any;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ApiClient Telegram token generation', () => {
  it('normalizes production snake_case response fields for the renderer', async () => {
    fetchMock.mockResolvedValueOnce(new Response(telegramTokenBody(), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const result = await new ApiClient('https://api.test').generateTelegramLoginToken();

    expect(result).toEqual({
      token: 'login-token-1',
      expiresAt: '2026-05-12T12:10:00.000Z',
      deepLink: 'https://t.me/ziraai_bot?start=login_login-token-1',
    });
  });

  it('retries a transient 405 once before failing QR login', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('Method Not Allowed', { status: 405 }))
      .mockResolvedValueOnce(new Response(telegramTokenBody({
        token: 'login-token-2',
        deep_link: 'https://t.me/ziraai_bot?start=login_login-token-2',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

    const pending = new ApiClient('https://api.test').generateTelegramLoginToken();
    await flushMicrotasks();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toMatchObject({
      token: 'login-token-2',
      deepLink: 'https://t.me/ziraai_bot?start=login_login-token-2',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
