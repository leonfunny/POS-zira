import { useState } from 'react';
import { ArrowRightLeft, Loader2, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import { Language } from '../../i18n/translations';
import { useFloorOverview, useTransferTable } from '../../hooks/useBilliardData';
import { useToast } from './Toast';

interface TransferTableDialogProps {
  sessionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  language: Language;
}

export function TransferTableDialog({
  sessionId,
  open,
  onOpenChange,
  language,
}: TransferTableDialogProps) {
  const { t } = useTranslation(language);
  const toast = useToast();
  const { data: floorOverview, loading, refetch } = useFloorOverview();
  const transferTable = useTransferTable(refetch);

  const [selectedTableId, setSelectedTableId] = useState('');

  const freeTables = ((floorOverview as any)?.resources || []).filter(
    (r: any) => r.status === 'FREE' || r.status === 'free'
  );

  const resetForm = () => {
    setSelectedTableId('');
  };

  const handleSubmit = async () => {
    if (!selectedTableId) return;

    try {
      await transferTable.mutate({
        sessionId,
        resourceId: selectedTableId,
      });
      toast.success(t('billiard.transferSuccess') || 'Table transferred successfully');
      resetForm();
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err?.message || t('billiard.transferError') || 'Failed to transfer table');
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center"
      onClick={() => handleOpenChange(false)}
    >
      <div
        className="bg-white rounded-xl shadow-xl max-w-md w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5" />
            {t('billiard.transferTable') || 'Transfer Table'}
          </h3>
        </div>

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1">
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              {t('billiard.transferDescription') ||
                'Select a free table to transfer this session to.'}
            </p>

            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : freeTables.length === 0 ? (
              <div className="text-center py-8 text-slate-500">
                <p className="text-sm">
                  {t('billiard.noFreeTables') || 'No free tables available'}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                {freeTables.map((table: any) => {
                  const isSelected = selectedTableId === table.id;
                  return (
                    <button
                      key={table.id}
                      type="button"
                      onClick={() => setSelectedTableId(table.id)}
                      className={`
                        relative flex flex-col items-center justify-center p-4 rounded-lg border-2 transition-colors
                        ${
                          isSelected
                            ? 'border-blue-600 bg-blue-50 text-blue-600'
                            : 'border-slate-200 hover:border-blue-300 hover:bg-slate-50'
                        }
                      `}
                    >
                      {isSelected && (
                        <CheckCircle2 className="absolute top-2 right-2 w-4 h-4 text-blue-600" />
                      )}
                      <span className="text-lg font-semibold">
                        {table.name || `Table ${table.number || table.id}`}
                      </span>
                      {table.capacity && (
                        <span className="text-xs text-slate-500 mt-1">
                          {t('billiard.capacity') || 'Capacity'}: {table.capacity}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50"
            onClick={() => handleOpenChange(false)}
            disabled={transferTable.isPending}
          >
            {t('common.cancel') || 'Cancel'}
          </button>
          <button
            className="px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 flex items-center justify-center"
            onClick={handleSubmit}
            disabled={!selectedTableId || transferTable.isPending}
          >
            {transferTable.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t('billiard.transferring') || 'Transferring...'}
              </>
            ) : (
              t('billiard.transferTable') || 'Transfer'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
