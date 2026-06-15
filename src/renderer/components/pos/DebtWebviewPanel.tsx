interface Props {
  open: boolean;
  salonCode?: string;
  onClose: () => void;
}

// The debt ledger lives as a web page (same backend, same UI as the phone
// version) and is simply embedded here so staff can record/collect debts
// without leaving the POS. The 4-digit salon code is passed in the URL so
// nobody has to retype it.
const DEBT_BASE = 'https://chesaigon.eshoper.pro/no';

export default function DebtWebviewPanel({ open, salonCode, onClose }: Props) {
  if (!open) return null;

  const src = salonCode
    ? `${DEBT_BASE}?code=${encodeURIComponent(salonCode)}`
    : DEBT_BASE;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 px-4 py-2">
        <span className="font-bold text-brand-600">Sổ nợ</span>
        <button
          onClick={onClose}
          className="rounded-lg bg-gray-100 px-4 py-2 font-medium hover:bg-gray-200"
        >
          Đóng
        </button>
      </div>
      <webview
        src={src}
        partition="persist:enail-debt"
        style={{ width: '100%', height: '100%', flex: 1 }}
      />
    </div>
  );
}
