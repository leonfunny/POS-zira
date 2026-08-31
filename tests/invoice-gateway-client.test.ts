import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  InvoiceGatewayBridgeError,
  LocalInvoiceGatewayWebSocketTransport,
  ZiraInvoiceBridgeClient,
  type InvoiceGatewayTransport,
} from '../src/main/invoice-gateway/client';
import type {
  InvoiceGatewayReplyFrame,
  InvoiceGatewayRequestBody,
  InvoiceGatewayRequestFrame,
} from '../src/main/invoice-gateway/contract';

describe('ZiraInvoiceBridgeClient', () => {
  it('uses the frame id as a fresh requestId and sends the stable mutation key separately', async () => {
    const frames: Array<InvoiceGatewayRequestFrame<InvoiceGatewayRequestBody>> = [];
    const transport: InvoiceGatewayTransport = {
      async send(frame) {
        frames.push(frame);
        if (frame.op === 'capabilities') {
          return {
            id: frame.id,
            ok: true,
            body: {
              contractVersion: 1,
              ready: true,
              companyNip: '5220052349',
              supportedIntents: ['FISCALISED_RETAIL'],
              channels: [{ id: 'channel-1', name: 'POS', enabled: true }],
            },
          };
        }
        return {
          id: frame.id,
          ok: true,
          body: frame.op === 'sync_pos_order'
            ? { importResult: 'IMPORTED', localOrderId: 'local-1', orderState: 'READY_TO_INVOICE', document: null }
            : { found: true, localOrderId: 'local-1', orderState: 'READY_TO_INVOICE', document: null },
        };
      },
    };
    let id = 0;
    const client = new ZiraInvoiceBridgeClient(transport, () => `request-${++id}`);
    const input = {
      idempotencyKey: 'pos-invoice:order-1:v1',
      channelId: 'channel-1',
      posOrderId: 'order-1',
      companyNip: '5220052349',
    };

    await client.capabilities();
    await client.syncPosOrder(input);
    await client.getDocumentStatus(input);

    expect(frames.map((frame) => frame.id)).toEqual([
      'request-1',
      'request-2',
      'request-3',
    ]);
    for (const frame of frames) {
      expect(frame.body).toMatchObject({
        contractVersion: 1,
        requestId: frame.id,
      });
    }
    expect(frames[1]).toMatchObject({
      op: 'sync_pos_order',
      body: {
        requestId: 'request-2',
        idempotencyKey: 'pos-invoice:order-1:v1',
        channelId: 'channel-1',
        posOrderId: 'order-1',
        companyNip: '5220052349',
        documentIntent: 'FISCALISED_RETAIL',
      },
    });
  });

  it('reads structured error code/message/retryable from reply.body.error', async () => {
    const transport: InvoiceGatewayTransport = {
      async send(frame): Promise<InvoiceGatewayReplyFrame> {
        return {
          id: frame.id,
          ok: false,
          body: {
            error: {
              code: 'POS_CHANNEL_MISSING',
              message: 'No enabled POS channel',
              retryable: false,
            },
          },
          error: 'request failed',
        };
      },
    };
    const client = new ZiraInvoiceBridgeClient(transport, () => 'request-1');

    await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({
      name: 'InvoiceGatewayBridgeError',
      code: 'POS_CHANNEL_MISSING',
      message: 'No enabled POS channel',
      retryable: false,
    }));
  });

  it.each([
    ['bridge request queue is full', 'BRIDGE_QUEUE_FULL', true],
    ['handler timed out', 'BRIDGE_HANDLER_TIMEOUT', true],
    ['duplicate in-flight request id request-1', 'BRIDGE_PROTOCOL_ERROR', false],
  ] as const)(
    'classifies legacy Rust transport error %j as %s (retryable=%s)',
    async (message, code, retryable) => {
      const transport: InvoiceGatewayTransport = {
        async send(frame): Promise<InvoiceGatewayReplyFrame> {
          return {
            id: frame.id,
            ok: false,
            body: null,
            error: message,
          };
        },
      };
      const client = new ZiraInvoiceBridgeClient(transport, () => 'request-1');

      await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({
        code,
        message,
        retryable,
      }));
    },
  );
});

describe('LocalInvoiceGatewayWebSocketTransport', () => {
  it('sends the token as the first frame and the JSON request second', async () => {
    class FakeSocket extends EventEmitter {
      readyState = WebSocket.CONNECTING;
      sent: string[] = [];

      send(value: string, callback: (error?: Error) => void): void {
        this.sent.push(String(value));
        callback();
        if (this.sent.length === 2) {
          const request = JSON.parse(this.sent[1]);
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
            id: request.id,
            ok: true,
            body: { pong: true },
            error: null,
          }))));
        }
      }

      close(): void {
        this.readyState = WebSocket.CLOSED;
      }
    }

    const socket = new FakeSocket();
    const transport = new LocalInvoiceGatewayWebSocketTransport({
      tokenProvider: () => 'a'.repeat(32),
      webSocketFactory: () => socket as unknown as WebSocket,
      timeoutMs: 1_000,
    });
    const pending = transport.send({
      id: 'request-1',
      op: 'capabilities',
      body: { contractVersion: 1, requestId: 'request-1' },
    });
    await Promise.resolve();
    socket.readyState = WebSocket.OPEN;
    socket.emit('open');

    await expect(pending).resolves.toMatchObject({ id: 'request-1', ok: true });
    expect(socket.sent[0]).toBe('a'.repeat(32));
    expect(JSON.parse(socket.sent[1])).toMatchObject({
      id: 'request-1',
      op: 'capabilities',
      body: { contractVersion: 1, requestId: 'request-1' },
    });
  });

  it('fails before opening a socket when the token is truncated', async () => {
    const factory = vi.fn();
    const transport = new LocalInvoiceGatewayWebSocketTransport({
      tokenProvider: () => 'short',
      webSocketFactory: factory,
    });
    await expect(transport.send({
      id: 'request-1',
      op: 'capabilities',
      body: { contractVersion: 1, requestId: 'request-1' },
    })).rejects.toEqual(expect.objectContaining<Partial<InvoiceGatewayBridgeError>>({
      code: 'BRIDGE_TOKEN_INVALID',
      retryable: false,
    }));
    expect(factory).not.toHaveBeenCalled();
  });

  it('fails immediately when the reply id does not match the request', async () => {
    class WrongReplySocket extends EventEmitter {
      readyState = WebSocket.CONNECTING;
      sends = 0;

      send(_value: string, callback: (error?: Error) => void): void {
        this.sends += 1;
        callback();
        if (this.sends === 2) {
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
            id: 'another-request',
            ok: true,
            body: {},
          }))));
        }
      }

      close(): void {
        this.readyState = WebSocket.CLOSED;
      }
    }
    const socket = new WrongReplySocket();
    const transport = new LocalInvoiceGatewayWebSocketTransport({
      tokenProvider: () => 'a'.repeat(32),
      webSocketFactory: () => socket as unknown as WebSocket,
      timeoutMs: 5_000,
    });
    const pending = transport.send({
      id: 'request-1',
      op: 'capabilities',
      body: { contractVersion: 1, requestId: 'request-1' },
    });
    await Promise.resolve();
    socket.readyState = WebSocket.OPEN;
    socket.emit('open');

    await expect(pending).rejects.toEqual(expect.objectContaining({
      code: 'RESPONSE_ID_MISMATCH',
      retryable: false,
    }));
  });

  it('rejects replies above the 64 KiB contract ceiling', async () => {
    class OversizeReplySocket extends EventEmitter {
      readyState = WebSocket.CONNECTING;
      sends = 0;

      send(_value: string, callback: (error?: Error) => void): void {
        this.sends += 1;
        callback();
        if (this.sends === 2) {
          queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({
            id: 'request-1',
            ok: true,
            body: { padding: 'x'.repeat(65 * 1024) },
          }))));
        }
      }

      close(): void {
        this.readyState = WebSocket.CLOSED;
      }
    }
    const socket = new OversizeReplySocket();
    const transport = new LocalInvoiceGatewayWebSocketTransport({
      tokenProvider: () => 'a'.repeat(32),
      webSocketFactory: () => socket as unknown as WebSocket,
      timeoutMs: 5_000,
    });
    const pending = transport.send({
      id: 'request-1',
      op: 'capabilities',
      body: { contractVersion: 1, requestId: 'request-1' },
    });
    await Promise.resolve();
    socket.readyState = WebSocket.OPEN;
    socket.emit('open');

    await expect(pending).rejects.toEqual(expect.objectContaining({
      code: 'BRIDGE_PROTOCOL_ERROR',
      retryable: false,
    }));
  });
});
