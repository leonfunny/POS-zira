/**
 * Executes a print plan against the two printer lanes.
 *
 * Kept out of the React component so the sequencing rules — which payload goes
 * to which lane, what happens on a stop or a failure — can be tested without
 * rendering anything.
 *
 * The whole order goes out in one continuous run, stickers then fabric, with no
 * prompt in between: the operator starts it and walks away. The only control
 * during a run is Stop, checked between steps.
 */
import { PrintStep } from '../../../shared/label-print-order';

export interface PrintOrderHeader {
  customerName: string;
  styleName: string;
  styleCode: string;
}

export interface PrintOrderApi {
  printSticker(request: {
    customerName: string;
    styleName: string;
    styleCode: string;
    colorName: string;
    code: string;
    sizeText?: string;
    quantity: number;
  }): Promise<{ success: boolean; error?: string }>;
  printFabricTag(request: {
    size: string;
    composition: string;
    careSymbols: string[];
    careText?: string;
    layout: string;
    quantity: number;
  }): Promise<{ success: boolean; error?: string }>;
}

export interface PrintProgress {
  type: 'printing' | 'success' | 'stopped' | 'error';
  completedSteps: number;
  totalSteps: number;
  printedCopies: number;
  totalCopies: number;
  /** The step about to run, or the one that failed. */
  step?: PrintStep;
}

export interface PrintOrderHooks {
  onProgress(progress: PrintProgress): void;
  /**
   * Checked before every step. The run never asks the operator anything, so
   * this is the only way it ends early — pressing Stop takes effect at the next
   * step boundary, which is why the plan is cut into batches rather than sent
   * as one job the printer would finish regardless.
   */
  shouldStop(): boolean;
}

export interface PrintOrderResult {
  type: 'success' | 'stopped' | 'error';
  completedSteps: number;
  printedCopies: number;
  completedIds: string[];
  failedStepId?: string;
  message?: string;
}

export interface RunOptions {
  /** Step ids already printed, from a previous partial run. */
  completedIds?: string[];
}

export async function runPrintPlan(
  plan: PrintStep[],
  header: PrintOrderHeader,
  api: PrintOrderApi,
  hooks: PrintOrderHooks,
  options: RunOptions = {},
): Promise<PrintOrderResult> {
  const alreadyDone = new Set(options.completedIds ?? []);
  const steps = plan.filter((step) => !alreadyDone.has(step.id));
  const totalCopies = steps.reduce((sum, step) => sum + step.quantity, 0);

  const completedIds: string[] = [];
  let printedCopies = 0;

  const report = (type: PrintProgress['type'], step?: PrintStep) =>
    hooks.onProgress({
      type,
      completedSteps: completedIds.length,
      totalSteps: steps.length,
      printedCopies,
      totalCopies,
      step,
    });

  const finish = (
    type: PrintOrderResult['type'],
    extra: Partial<PrintOrderResult> = {},
  ): PrintOrderResult => {
    report(type);
    return {
      type,
      completedSteps: completedIds.length,
      printedCopies,
      completedIds,
      ...extra,
    };
  };

  for (const step of steps) {

    if (hooks.shouldStop()) return finish('stopped');

    report('printing', step);

    let result: { success: boolean; error?: string };
    try {
      result =
        step.kind === 'sticker'
          ? await api.printSticker({
              customerName: header.customerName,
              styleName: header.styleName,
              styleCode: header.styleCode,
              colorName: step.colorName,
              code: step.code,
              sizeText: step.sizeText,
              quantity: step.quantity,
            })
          : await api.printFabricTag({
              size: step.sizeText,
              composition: step.composition,
              careSymbols: step.careSymbols,
              careText: step.careText || undefined,
              layout: 'default',
              quantity: step.quantity,
            });
    } catch (error: any) {
      return finish('error', {
        failedStepId: step.id,
        message: error?.message || String(error),
      });
    }

    if (!result || result.success !== true) {
      return finish('error', {
        failedStepId: step.id,
        message: result?.error || 'Print failed',
      });
    }

    completedIds.push(step.id);
    printedCopies += step.quantity;
  }

  return finish('success');
}
