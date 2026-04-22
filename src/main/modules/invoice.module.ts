/**
 * InvoiceModule
 *
 * Wraps the existing registerInvoiceHandlers() + registerEntitlementsHandlers()
 * from invoice-controller.ts and entitlements-controller.ts.
 *
 * Also registers AI tools for invoice operations.
 */

import { BaseModule, ModuleState } from '../core/module';
import type { ServiceContainer } from '../core/container';
import type { EventBus } from '../core/event-bus';
import type { ToolDefinition } from '../core/tool-registry';
import { SERVICE_TOKENS } from '../core/tokens';
import { registerInvoiceHandlers } from '../invoice/invoice-controller';
import { registerEntitlementsHandlers } from '../entitlements/entitlements-controller';
import { invoiceRepo } from '../database/repos/invoice-repo';
import { nipLookupService } from '../invoice/nip-lookup';
import { getConfig } from '../config/store';
import type { BrowserWindow } from 'electron';
import logger from '../logger';

export class InvoiceModule extends BaseModule {
  readonly name = 'invoice';

  constructor(private container: ServiceContainer) {
    super();
  }

  async init(): Promise<void> {
    logger.info('[InvoiceModule] Initializing...');
    this.setState(ModuleState.READY);
  }

  registerIpcHandlers(): void {
    // Delegate to existing functions - they already register all ipcMain.handle()s
    registerInvoiceHandlers(
      () => {
        const printers = this.container.getOptional<Record<string, any>>(SERVICE_TOKENS.PRINTERS);
        return printers?.['RECEIPT'] || null;
      },
      () => {
        const config = getConfig();
        return config.printers?.['A4']?.windowsPrinter || null;
      },
      this.container,
    );

    // Entitlements
    const mainWindow = this.container.getOptional<BrowserWindow>(SERVICE_TOKENS.MAIN_WINDOW);
    registerEntitlementsHandlers(mainWindow || null);

    logger.info('[InvoiceModule] IPC handlers registered');
  }

  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        definition: {
          type: 'function',
          function: {
            name: 'create_invoice',
            description: 'Create a new invoice or receipt in the local invoicing system',
            parameters: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['INVOICE', 'RECEIPT', 'PROFORMA'], description: 'Invoice type' },
                customer_nip: { type: 'string', description: 'Customer NIP/VAT number' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      quantity: { type: 'number' },
                      unit_price: { type: 'number', description: 'Price in grosze (cents)' },
                      vat_rate: { type: 'number', enum: [23, 8, 5, 0] },
                    },
                    required: ['name', 'quantity', 'unit_price', 'vat_rate'],
                  },
                },
              },
              required: ['type', 'items'],
            },
          },
        },
        module: this.name,
        category: 'invoicing',
        execute: async (args) => {
          try {
            const result = invoiceRepo.create(args as any);
            return `✅ Invoice created: ${result.invoice.invoice_number} (${result.invoice.type})`;
          } catch (e: any) {
            return `❌ Failed to create invoice: ${e.message}`;
          }
        },
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'lookup_nip',
            description: 'Look up company details by Polish NIP number or EU VAT ID',
            parameters: {
              type: 'object',
              properties: {
                identifier: { type: 'string', description: 'NIP or EU VAT ID (e.g., 5252344078 or PL5252344078)' },
              },
              required: ['identifier'],
            },
          },
        },
        module: this.name,
        category: 'invoicing',
        execute: async (args) => {
          try {
            const result = await nipLookupService.lookup(args.identifier as string);
            if (!result) return '❌ NIP not found';
            return `✅ Company: ${result.name}\nAddress: ${result.street}, ${result.city} ${result.postalCode}\nNIP: ${result.nip}`;
          } catch (e: any) {
            return `❌ NIP lookup failed: ${e.message}`;
          }
        },
      },
      {
        definition: {
          type: 'function',
          function: {
            name: 'get_invoice_stats',
            description: 'Get invoice statistics (count, total amounts by type)',
            parameters: { type: 'object', properties: {}, required: [] },
          },
        },
        module: this.name,
        category: 'invoicing',
        execute: async () => {
          try {
            const all = invoiceRepo.list({});
            const stats = {
              total: all.length,
              byType: {} as Record<string, number>,
            };
            for (const inv of all) {
              stats.byType[inv.type] = (stats.byType[inv.type] || 0) + 1;
            }
            return `📊 Invoice stats: ${stats.total} total\n${Object.entries(stats.byType).map(([k, v]) => `  ${k}: ${v}`).join('\n')}`;
          } catch (e: any) {
            return `❌ Failed to get stats: ${e.message}`;
          }
        },
      },
    ];
  }

  registerEventHandlers(_bus: EventBus): void {
    // Invoice module doesn't need to react to cross-module events currently
  }

  async start(): Promise<void> {
    this.setState(ModuleState.RUNNING);
    logger.info('[InvoiceModule] Started');
  }

  async stop(): Promise<void> {
    this.setState(ModuleState.STOPPED);
    logger.info('[InvoiceModule] Stopped');
  }

  async destroy(): Promise<void> {
    this.setState(ModuleState.STOPPED);
  }
}
