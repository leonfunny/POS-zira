import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

const posSource = readFileSync('src/main/modules/pos.module.ts', 'utf8');
const fiscalRepoSource = readFileSync(
  'src/main/database/repos/fiscal-attempt-repo.ts',
  'utf8',
);
const paymentSource = readFileSync('src/main/pos/payment-controller.ts', 'utf8');

describe('fiscal journal -> Zira Invoice shadow handoff wiring', () => {
  it('does not enqueue from ordinary pos:orders:create', () => {
    const createStart = posSource.indexOf("ipcMain.handle('pos:orders:create'");
    const createEnd = posSource.indexOf(
      '\n    ipcMain.handle(',
      createStart + "ipcMain.handle('pos:orders:create'".length,
    );
    const createHandler = posSource.slice(createStart, createEnd);

    expect(createStart).toBeGreaterThanOrEqual(0);
    expect(createEnd).toBeGreaterThan(createStart);
    expect(createHandler).not.toContain('invoiceHandoffRepo');
    expect(createHandler).not.toContain('pos-invoice:');
    expect(posSource).not.toContain('configureInvoiceHandoffContextProvider');
  });

  it('attaches the handoff only at confirmed fiscal evidence boundaries', () => {
    const repoStart = fiscalRepoSource.indexOf('export const fiscalAttemptRepo');
    const repoImplementation = fiscalRepoSource.indexOf('} = {', repoStart);
    const createPending = fiscalRepoSource.slice(
      fiscalRepoSource.indexOf('createPending(input:', repoStart),
      fiscalRepoSource.indexOf('getReceiptSnapshot(', fiscalRepoSource.indexOf('createPending(input:', repoStart)),
    );
    const markSuccess = fiscalRepoSource.slice(
      fiscalRepoSource.indexOf('markSuccess(id:', repoStart),
      fiscalRepoSource.indexOf('markFailed(id:', fiscalRepoSource.indexOf('markSuccess(id:', repoStart)),
    );
    const remoteSuccess = fiscalRepoSource.slice(
      fiscalRepoSource.indexOf('recordRemoteFiscalSuccess(', repoImplementation),
      fiscalRepoSource.indexOf('findLatestByOrder(', fiscalRepoSource.indexOf('recordRemoteFiscalSuccess(', repoImplementation)),
    );
    const reconciliation = fiscalRepoSource.slice(
      fiscalRepoSource.indexOf('resolveReconcilable(orderId:', repoStart),
      fiscalRepoSource.indexOf('getNextAttemptNo(', fiscalRepoSource.indexOf('resolveReconcilable(orderId:', repoStart)),
    );

    expect(createPending).not.toContain('tryEnsureInvoiceHandoff');
    expect(markSuccess).toContain('parseFiscalisedRetailSale(attempt.payload_json)');
    expect(markSuccess).toContain('tryEnsureInvoiceHandoff(attempt.order_id, receipt)');
    expect(remoteSuccess).toContain('tryEnsureInvoiceHandoff(orderId, receiptData)');
    expect(reconciliation).toContain("if (didPrint)");
    expect(reconciliation).toContain('parseFiscalisedRetailSale(attempt.payload_json)');
    expect(reconciliation).toContain('tryEnsureInvoiceHandoff(orderId, receipt)');
    expect(fiscalRepoSource).toContain('receipt.isRefund !== true');
    expect(fiscalRepoSource).toContain('receipt.isReprint !== true');
    expect(paymentSource).toContain('const persisted = await fiscalAttemptRepo.flush()');
  });
});
