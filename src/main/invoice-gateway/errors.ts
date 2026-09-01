export class InvoiceGatewayBridgeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'InvoiceGatewayBridgeError';
  }
}
