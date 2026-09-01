import { createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';
import {
  LocalInvoiceGatewayWebSocketTransport,
  ZiraInvoiceBridgeClient,
} from '../src/main/invoice-gateway/client';
import {
  INVOICE_GATEWAY_CONTRACT_VERSION,
  type InvoiceGatewayCapabilities,
} from '../src/main/invoice-gateway/contract';

function wireText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function waitForListening(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

async function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.terminate();

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out while closing the loopback WebSocket server'));
    }, 1_000);
    timer.unref();

    server.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('invoice gateway real WebSocket wire contract', () => {
  it('authenticates first, then sends and receives capabilities over loopback', async () => {
    const token = 'wire-token-0123456789abcdef0123456789abcdef';
    const requestId = 'wire-capabilities-request-1';
    const expectedCapabilities: InvoiceGatewayCapabilities = {
      contractVersion: INVOICE_GATEWAY_CONTRACT_VERSION,
      ready: true,
      companyNip: '5220052349',
      supportedIntents: ['FISCALISED_RETAIL'],
      channels: [{ id: 'wire-channel', name: 'Wire test', enabled: true }],
    };
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });

    try {
      await waitForListening(server);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Loopback WebSocket server did not expose a TCP port');
      }

      const exchange = new Promise<void>((resolve, reject) => {
        server.once('connection', (socket) => {
          let frameNumber = 0;
          const fail = (error: unknown): void => {
            socket.terminate();
            reject(error);
          };

          socket.on('message', (data) => {
            try {
              frameNumber += 1;
              const text = wireText(data);

              if (frameNumber === 1) {
                expect(text).toBe(token);
                expect(text.length).toBeGreaterThanOrEqual(32);
                return;
              }

              if (frameNumber === 2) {
                const request = JSON.parse(text);
                expect(request).toEqual({
                  id: requestId,
                  op: 'capabilities',
                  body: {
                    contractVersion: INVOICE_GATEWAY_CONTRACT_VERSION,
                    requestId,
                  },
                });
                expect(request.body.requestId).toBe(request.id);

                socket.send(JSON.stringify({
                  id: request.id,
                  ok: true,
                  body: expectedCapabilities,
                  error: null,
                }), (error) => {
                  if (error) fail(error);
                  else resolve();
                });
              }
            } catch (error) {
              fail(error);
            }
          });
          socket.once('error', fail);
        });
      });

      const transport = new LocalInvoiceGatewayWebSocketTransport({
        tokenProvider: () => token,
        url: `ws://127.0.0.1:${address.port}`,
        timeoutMs: 1_000,
      });
      const client = new ZiraInvoiceBridgeClient(transport, () => requestId);

      const [capabilities] = await Promise.all([
        client.capabilities(),
        exchange,
      ]);

      expect(capabilities).toEqual(expectedCapabilities);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects a hung CONNECTING handshake without an unhandled late socket error', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      // Deliberately accept TCP but never answer the WebSocket upgrade.
    });
    server.listen(0, '127.0.0.1');

    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Hung-handshake server did not expose a TCP port');
      }
      const transport = new LocalInvoiceGatewayWebSocketTransport({
        tokenProvider: () => 'hung-token-0123456789abcdef0123456789abcdef',
        url: `ws://127.0.0.1:${address.port}`,
        timeoutMs: 1_000,
      });
      const client = new ZiraInvoiceBridgeClient(transport, () => 'hung-request-1');

      await expect(client.capabilities()).rejects.toEqual(expect.objectContaining({
        code: 'BRIDGE_TIMEOUT',
        retryable: true,
      }));
      // Let the abortHandshake error scheduled by `ws` reach the event loop.
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});
