import { randomUUID } from 'crypto';
import WebSocket, { type RawData } from 'ws';
import { InvoiceGatewayBridgeError } from './errors';
import {
  INVOICE_GATEWAY_CONTRACT_VERSION,
  INVOICE_GATEWAY_DOCUMENT_INTENT,
  type GetDocumentStatusBody,
  type GetDocumentStatusResult,
  type InvoiceGatewayCapabilities,
  type InvoiceGatewayOperation,
  type InvoiceGatewayReplyFrame,
  type InvoiceGatewayRequestBody,
  type InvoiceGatewayRequestFrame,
  type InvoiceGatewayStructuredError,
  type SyncPosOrderBody,
  type SyncPosOrderResult,
} from './contract';

export interface InvoiceGatewayTransport {
  send<TBody extends InvoiceGatewayRequestBody>(
    frame: InvoiceGatewayRequestFrame<TBody>,
  ): Promise<InvoiceGatewayReplyFrame>;
}

export type InvoiceGatewayTokenProvider = () => Promise<string> | string;

export interface LocalInvoiceGatewayWebSocketTransportOptions {
  tokenProvider: InvoiceGatewayTokenProvider;
  url?: string;
  timeoutMs?: number;
  webSocketFactory?: (url: string) => WebSocket;
}

export { InvoiceGatewayBridgeError } from './errors';

function asReplyFrame(value: unknown): InvoiceGatewayReplyFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice returned an invalid reply frame',
      'BRIDGE_PROTOCOL_ERROR',
      false,
    );
  }
  const frame = value as Partial<InvoiceGatewayReplyFrame>;
  if (!String(frame.id || '').trim() || typeof frame.ok !== 'boolean') {
    throw new InvoiceGatewayBridgeError(
      'Zira Invoice reply is missing id/ok',
      'BRIDGE_PROTOCOL_ERROR',
      false,
    );
  }
  return {
    id: String(frame.id),
    ok: frame.ok,
    body: frame.body ?? null,
    error: frame.error ?? null,
  };
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/**
 * One authenticated localhost socket per request. Nothing starts or retries
 * in the constructor; a future runtime owner must explicitly call the worker.
 */
export class LocalInvoiceGatewayWebSocketTransport implements InvoiceGatewayTransport {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly webSocketFactory: (url: string) => WebSocket;

  constructor(private readonly options: LocalInvoiceGatewayWebSocketTransportOptions) {
    this.url = options.url ?? 'ws://127.0.0.1:9787';
    // Rust parks each handler for 60s. Fail first so the worker owns the
    // ambiguity/reconciliation path instead of receiving a server-side race.
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 55_000);
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  async send<TBody extends InvoiceGatewayRequestBody>(
    frame: InvoiceGatewayRequestFrame<TBody>,
  ): Promise<InvoiceGatewayReplyFrame> {
    const token = String(await this.options.tokenProvider()).trim();
    if (token.length < 32) {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice bridge token is missing or truncated',
        'BRIDGE_TOKEN_INVALID',
        false,
      );
    }

    return new Promise<InvoiceGatewayReplyFrame>((resolve, reject) => {
      const socket = this.webSocketFactory(this.url);
      let settled = false;
      const timer = setTimeout(() => {
        fail(new InvoiceGatewayBridgeError(
          'Zira Invoice bridge request timed out',
          'BRIDGE_TIMEOUT',
          true,
        ));
      }, this.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeAllListeners();
        // `ws.close()` while CONNECTING aborts the handshake and emits an
        // asynchronous error. Keep a one-shot sink installed after detaching
        // the request handlers so a normal timeout cannot become an uncaught
        // process-level error.
        socket.once('error', () => undefined);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      };
      const succeed = (reply: InvoiceGatewayReplyFrame): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(reply);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof InvoiceGatewayBridgeError
          ? error
          : new InvoiceGatewayBridgeError(
            error instanceof Error ? error.message : String(error),
            'BRIDGE_CONNECTION_ERROR',
            true,
          ));
      };

      socket.once('open', () => {
        // The Rust listener requires the raw token as the first frame and
        // deliberately sends no auth acknowledgement. ws preserves send order.
        socket.send(token, (authError) => {
          if (authError) {
            fail(authError);
            return;
          }
          socket.send(JSON.stringify(frame), (requestError) => {
            if (requestError) fail(requestError);
          });
        });
      });
      socket.on('message', (data) => {
        try {
          const text = rawDataToString(data);
          if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
            throw new InvoiceGatewayBridgeError(
              'Zira Invoice bridge reply exceeded 64 KiB',
              'BRIDGE_PROTOCOL_ERROR',
              false,
            );
          }
          const reply = asReplyFrame(JSON.parse(text));
          if (reply.id !== frame.id) {
            throw new InvoiceGatewayBridgeError(
              'Zira Invoice replied with a different request id',
              'RESPONSE_ID_MISMATCH',
              false,
            );
          }
          succeed(reply);
        } catch (error) {
          fail(error);
        }
      });
      socket.once('error', fail);
      socket.once('close', () => {
        fail(new InvoiceGatewayBridgeError(
          'Zira Invoice bridge closed before replying',
          'BRIDGE_CONNECTION_CLOSED',
          true,
        ));
      });
    });
  }
}

export interface InvoiceGatewayMutationInput {
  idempotencyKey: string;
  channelId: string;
  posOrderId: string;
  companyNip: string;
}

export interface ZiraInvoiceBridgeClientLike {
  newRequestId(): string;
  capabilities(requestId?: string): Promise<InvoiceGatewayCapabilities>;
  syncPosOrder(
    input: InvoiceGatewayMutationInput,
    requestId?: string,
  ): Promise<SyncPosOrderResult>;
  getDocumentStatus(
    input: InvoiceGatewayMutationInput,
    requestId?: string,
  ): Promise<GetDocumentStatusResult>;
}

export class ZiraInvoiceBridgeClient implements ZiraInvoiceBridgeClientLike {
  constructor(
    private readonly transport: InvoiceGatewayTransport,
    private readonly createRequestId: () => string = randomUUID,
  ) {}

  newRequestId(): string {
    const requestId = String(this.createRequestId() || '').trim();
    if (!requestId) {
      throw new InvoiceGatewayBridgeError(
        'Could not allocate a bridge request id',
        'REQUEST_ID_INVALID',
        false,
      );
    }
    return requestId;
  }

  capabilities(requestId = this.newRequestId()): Promise<InvoiceGatewayCapabilities> {
    return this.request('capabilities', requestId, {
      contractVersion: INVOICE_GATEWAY_CONTRACT_VERSION,
      requestId,
    });
  }

  syncPosOrder(
    input: InvoiceGatewayMutationInput,
    requestId = this.newRequestId(),
  ): Promise<SyncPosOrderResult> {
    const body: SyncPosOrderBody = {
      contractVersion: INVOICE_GATEWAY_CONTRACT_VERSION,
      requestId,
      idempotencyKey: input.idempotencyKey,
      channelId: input.channelId,
      posOrderId: input.posOrderId,
      companyNip: input.companyNip,
      documentIntent: INVOICE_GATEWAY_DOCUMENT_INTENT,
    };
    return this.request('sync_pos_order', requestId, body);
  }

  getDocumentStatus(
    input: InvoiceGatewayMutationInput,
    requestId = this.newRequestId(),
  ): Promise<GetDocumentStatusResult> {
    const body: GetDocumentStatusBody = {
      contractVersion: INVOICE_GATEWAY_CONTRACT_VERSION,
      requestId,
      idempotencyKey: input.idempotencyKey,
      channelId: input.channelId,
      posOrderId: input.posOrderId,
      companyNip: input.companyNip,
      documentIntent: INVOICE_GATEWAY_DOCUMENT_INTENT,
    };
    return this.request('get_document_status', requestId, body);
  }

  private async request<TResult, TBody extends InvoiceGatewayRequestBody>(
    op: InvoiceGatewayOperation,
    requestId: string,
    body: TBody,
  ): Promise<TResult> {
    const cleanRequestId = String(requestId || '').trim();
    if (!cleanRequestId || body.requestId !== cleanRequestId) {
      throw new InvoiceGatewayBridgeError(
        'Bridge frame id and body requestId must match',
        'REQUEST_ID_MISMATCH',
        false,
      );
    }
    const reply = await this.transport.send({ id: cleanRequestId, op, body });
    if (reply.id !== cleanRequestId) {
      throw new InvoiceGatewayBridgeError(
        'Zira Invoice replied with a different request id',
        'RESPONSE_ID_MISMATCH',
        false,
      );
    }
    if (!reply.ok) throw bridgeErrorFromReply(reply);
    return reply.body as TResult;
  }
}

function bridgeErrorFromReply(reply: InvoiceGatewayReplyFrame): InvoiceGatewayBridgeError {
  const bodyError = reply.body && typeof reply.body === 'object' && !Array.isArray(reply.body)
    ? (reply.body as { error?: InvoiceGatewayStructuredError }).error
    : undefined;
  const topError = reply.error;
  const structured = bodyError && typeof bodyError === 'object'
    ? bodyError
    : topError && typeof topError === 'object'
      ? topError
      : undefined;
  const legacyMessage = !structured && typeof topError === 'string' ? topError.trim() : '';
  const legacyClassification = /bridge request queue is full/i.test(legacyMessage)
    ? { code: 'BRIDGE_QUEUE_FULL', retryable: true }
    : /handler timed out/i.test(legacyMessage)
      ? { code: 'BRIDGE_HANDLER_TIMEOUT', retryable: true }
      : /duplicate in-flight request id/i.test(legacyMessage)
        ? { code: 'BRIDGE_PROTOCOL_ERROR', retryable: false }
        : null;
  const message = String(
    structured?.message
    || legacyMessage
    || 'Zira Invoice rejected the bridge request',
  );
  return new InvoiceGatewayBridgeError(
    message,
    String(structured?.code || legacyClassification?.code || 'BRIDGE_REQUEST_REJECTED'),
    structured?.retryable === true || legacyClassification?.retryable === true,
  );
}
