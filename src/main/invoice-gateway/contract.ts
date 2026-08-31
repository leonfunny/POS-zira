export const INVOICE_GATEWAY_CONTRACT_VERSION = 1 as const;
export const INVOICE_GATEWAY_DOCUMENT_INTENT = 'FISCALISED_RETAIL' as const;

export type InvoiceGatewayOperation =
  | 'capabilities'
  | 'sync_pos_order'
  | 'get_document_status';

export interface InvoiceGatewayRequestBody {
  contractVersion: typeof INVOICE_GATEWAY_CONTRACT_VERSION;
  requestId: string;
}

export interface InvoiceGatewayRequestFrame<TBody extends InvoiceGatewayRequestBody> {
  id: string;
  op: InvoiceGatewayOperation;
  body: TBody;
}

export interface InvoiceGatewayChannel {
  id: string;
  name: string;
  enabled: boolean;
}

export interface InvoiceGatewayCapabilities {
  contractVersion: typeof INVOICE_GATEWAY_CONTRACT_VERSION;
  ready: boolean;
  companyNip: string | null;
  supportedIntents: string[];
  channels: InvoiceGatewayChannel[];
}

export interface InvoiceGatewayDocument {
  kind: string;
  id: string;
  number?: string;
  status: string;
  ksefStatus?: string;
}

export interface SyncPosOrderBody extends InvoiceGatewayRequestBody {
  idempotencyKey: string;
  channelId: string;
  posOrderId: string;
  companyNip: string;
  documentIntent: typeof INVOICE_GATEWAY_DOCUMENT_INTENT;
}

export interface SyncPosOrderResult {
  importResult: 'IMPORTED' | 'ALREADY_IMPORTED';
  localOrderId: string;
  orderState: string;
  document: InvoiceGatewayDocument | null;
}

export interface GetDocumentStatusBody extends SyncPosOrderBody {}

export interface GetDocumentStatusResult {
  found: boolean;
  localOrderId?: string;
  orderState?: string;
  document: InvoiceGatewayDocument | null;
}

export interface InvoiceGatewayStructuredError {
  code?: string;
  message?: string;
  retryable?: boolean;
}

export interface InvoiceGatewayReplyFrame {
  id: string;
  ok: boolean;
  body: unknown;
  error?: string | InvoiceGatewayStructuredError | null;
}
