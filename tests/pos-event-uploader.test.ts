import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = {
  listReady: vi.fn(),
  markAcked: vi.fn(),
  markFailed: vi.fn(),
  countPending: vi.fn(() => 0),
  countDeadLetter: vi.fn(() => 0),
  oldestPendingAt: vi.fn(() => null),
  lastAckedAt: vi.fn(() => null),
  toEnvelope: vi.fn((r: any) => ({
    eventId: r.event_id,
    eventType: r.event_type,
    schemaVersion: 1,
    occurredAt: r.occurred_at,
    reliabilityClass: r.reliability_class,
    payload: {},
  })),
};

const postPosEvents = vi.fn();

vi.mock('../src/main/database/repos/pos-event-outbox-repo', () => ({
  posEventOutboxRepo: repo,
}));
vi.mock('../src/main/network/api-client', () => ({
  apiClient: { postPosEvents: (...a: unknown[]) => postPosEvents(...a) },
}));
vi.mock('../src/main/config/store', () => ({
  getSecureAuthToken: vi.fn(() => 'token-1'),
  getConfigValue: vi.fn(() => 'dev-1'),
}));
vi.mock('../src/main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn() } }));

import { PosEventUploader } from '../src/main/sync/pos-event-uploader';

function row(id: string, attempts = 0): any {
  return {
    event_id: id,
    event_type: 'SaleCompleted',
    occurred_at: '2026-06-21T10:00:00.000Z',
    reliability_class: 'important_business',
    attempts,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.countPending.mockReturnValue(0);
  repo.listReady.mockReturnValue([]);
});

describe('PosEventUploader.flush', () => {
  it('acks both accepted and duplicate events; never fails them', async () => {
    repo.listReady.mockReturnValueOnce([row('a'), row('b')]).mockReturnValue([]);
    postPosEvents.mockResolvedValue({
      accepted: [{ eventId: 'a', serverEventId: 'srv-a' }],
      duplicates: [{ eventId: 'b', serverEventId: 'srv-b' }],
      rejected: [],
      serverTime: 'now',
    });

    const result = await new PosEventUploader().flush();

    expect(result.acked).toBe(2);
    expect(repo.markAcked).toHaveBeenCalledWith('a', 'srv-a');
    expect(repo.markAcked).toHaveBeenCalledWith('b', 'srv-b');
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it('fails a rejected event with backoff (not dead-lettered while attempts are low)', async () => {
    repo.listReady.mockReturnValueOnce([row('a', 1)]).mockReturnValue([]);
    postPosEvents.mockResolvedValue({
      accepted: [],
      duplicates: [],
      rejected: [{ eventId: 'a', errorCode: 'INVALID_SCHEMA', message: 'bad' }],
      serverTime: 'now',
    });

    await new PosEventUploader().flush();

    expect(repo.markAcked).not.toHaveBeenCalled();
    const [eventId, , , deadLetter] = repo.markFailed.mock.calls[0];
    expect(eventId).toBe('a');
    expect(deadLetter).toBe(false);
  });

  it('dead-letters a permanently rejected event once attempts cross the threshold', async () => {
    repo.listReady.mockReturnValueOnce([row('a', 24)]).mockReturnValue([]);
    postPosEvents.mockResolvedValue({
      accepted: [],
      duplicates: [],
      rejected: [{ eventId: 'a', errorCode: 'INVALID_SCHEMA', message: 'bad' }],
      serverTime: 'now',
    });

    await new PosEventUploader().flush();

    const deadLetter = repo.markFailed.mock.calls[0][3];
    expect(deadLetter).toBe(true);
  });

  it('on a network error, backs off every row and never dead-letters', async () => {
    repo.listReady.mockReturnValueOnce([row('a'), row('b')]).mockReturnValue([]);
    postPosEvents.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await new PosEventUploader().flush();

    expect(result.failed).toBe(2);
    expect(repo.markAcked).not.toHaveBeenCalled();
    expect(repo.markFailed).toHaveBeenCalledTimes(2);
    for (const call of repo.markFailed.mock.calls) {
      expect(call[3]).toBe(false); // deadLetter never true on transport failure
    }
  });

  it('does nothing when there is no auth token', async () => {
    const store = await import('../src/main/config/store');
    (store.getSecureAuthToken as any).mockReturnValueOnce(null);
    await new PosEventUploader().flush();
    expect(postPosEvents).not.toHaveBeenCalled();
  });

  it('does not attempt upload while offline', async () => {
    repo.listReady.mockReturnValue([row('a')]);
    await new PosEventUploader(() => false).flush();
    expect(postPosEvents).not.toHaveBeenCalled();
  });
});
