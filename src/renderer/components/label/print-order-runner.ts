/**
 * Executes a print plan against the two printer lanes.
 *
 * Kept out of the React component so the sequencing rules — which payload goes
 * to which lane, where the operator is asked to tear the strip, what happens on
 * a stop or a failure — can be tested without rendering anything.
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
  type: 'printing' | 'waiting' | 'success' | 'stopped' | 'error';
  completedSteps: number;
  totalSteps: number;
  printedCopies: number;
  totalCopies: number;
  /** The step about to run, or the one that failed. */
  step?: PrintStep;
}

export interface PrintOrderHooks {
  onProgress(progress: PrintProgress): void;
  /** Resolves when the operator picks Continue or Stop at a tear pause. */
  awaitDecision(): Promise<'continue' | 'stop'>;
  /** Checked before each step; lets Stop take effect without a pause. */
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

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];

    if (hooks.shouldStop()) return finish('stopped');

    // The fabric printer has no cutter: the operator tears between bundles, so
    // every fabric run but the first of an uninterrupted sequence waits for a
    // decision. Stickers are die-cut and never wait.
    const previous = index > 0 ? steps[index - 1] : undefined;
    const needsTearPause = step.kind === 'fabric' && previous !== undefined;
    if (needsTearPause) {
      report('waiting', step);
      const decision = await hooks.awaitDecision();
      if (decision === 'stop' || hooks.shouldStop()) return finish('stopped');
    }

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
