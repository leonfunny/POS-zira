import { useState, type FormEvent, type ReactNode } from 'react';
import type { Language } from '../i18n/translations';
import type { KioskExitPinResult } from './shim/kiosk-exit-pin';

interface AndroidCustomerCheckinShellProps {
  children: ReactNode;
  language: Language;
  verifyStaffExit: (pin: string) => Promise<KioskExitPinResult>;
  onStaffExit: () => void;
}

const COPY = {
  pl: {
    staff: 'Personel', title: 'Powrót do POS', pin: 'Kod wyjścia z kiosku',
    cancel: 'Wróć', unlock: 'Odblokuj', invalid: 'Nieprawidłowy kod.',
    unset: 'Kod wyjścia z kiosku nie jest ustawiony. Poproś właściciela lub kierownika.',
    locked: 'Zbyt wiele prób. Spróbuj ponownie za kilka minut.',
    unavailable: 'Bezpieczne przechowywanie kodu jest niedostępne. Kiosk pozostaje zablokowany.',
  },
  en: {
    staff: 'Staff', title: 'Return to POS', pin: 'Kiosk exit PIN',
    cancel: 'Back', unlock: 'Unlock', invalid: 'Incorrect code.',
    unset: 'The kiosk exit PIN is not configured. Ask an owner or manager.',
    locked: 'Too many attempts. Try again in a few minutes.',
    unavailable: 'Secure PIN storage is unavailable. The kiosk remains locked.',
  },
  vi: {
    staff: 'Nhân viên', title: 'Quay lại POS', pin: 'PIN thoát kiosk',
    cancel: 'Quay lại', unlock: 'Mở khóa', invalid: 'PIN không đúng.',
    unset: 'PIN thoát kiosk chưa được thiết lập. Vui lòng gặp chủ hoặc quản lý.',
    locked: 'Đã thử quá nhiều lần. Vui lòng thử lại sau vài phút.',
    unavailable: 'Không thể dùng bộ nhớ PIN bảo mật. Kiosk vẫn bị khóa.',
  },
  tr: {
    staff: 'Personel', title: "POS'a dön", pin: 'Kiosk çıkış PIN’i',
    cancel: 'Geri', unlock: 'Kilidi aç', invalid: 'PIN yanlış.',
    unset: 'Kiosk çıkış PIN’i ayarlanmamış. İşletme sahibine veya yöneticiye başvurun.',
    locked: 'Çok fazla deneme yapıldı. Birkaç dakika sonra tekrar deneyin.',
    unavailable: 'Güvenli PIN depolaması kullanılamıyor. Kiosk kilitli kalacak.',
  },
  zh: {
    staff: '员工', title: '返回 POS', pin: '自助机退出 PIN',
    cancel: '返回', unlock: '解锁', invalid: 'PIN 不正确。',
    unset: '尚未设置自助机退出 PIN，请联系店主或经理。',
    locked: '尝试次数过多，请几分钟后再试。',
    unavailable: '安全 PIN 存储不可用，自助机将保持锁定。',
  },
  uk: {
    staff: 'Персонал', title: 'Повернутися до POS', pin: 'PIN-код виходу з кіоску',
    cancel: 'Назад', unlock: 'Розблокувати', invalid: 'Неправильний PIN-код.',
    unset: 'PIN-код виходу з кіоску не налаштовано. Зверніться до власника або менеджера.',
    locked: 'Забагато спроб. Повторіть через кілька хвилин.',
    unavailable: 'Захищене сховище PIN недоступне. Кіоск залишається заблокованим.',
  },
  ru: {
    staff: 'Персонал', title: 'Вернуться в POS', pin: 'PIN-код выхода из киоска',
    cancel: 'Назад', unlock: 'Разблокировать', invalid: 'Неверный PIN-код.',
    unset: 'PIN-код выхода из киоска не настроен. Обратитесь к владельцу или менеджеру.',
    locked: 'Слишком много попыток. Повторите через несколько минут.',
    unavailable: 'Защищённое хранилище PIN недоступно. Киоск остаётся заблокированным.',
  },
} as const;

export default function AndroidCustomerCheckinShell({
  children,
  language,
  verifyStaffExit,
  onStaffExit,
}: AndroidCustomerCheckinShellProps) {
  const copy = COPY[language];
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    if (submitting) return;
    setOpen(false);
    setPin('');
    setMessage(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await verifyStaffExit(pin);
      setPin('');
      if (result.success) {
        setOpen(false);
        onStaffExit();
      } else if (result.code === 'UNSET') setMessage(copy.unset);
      else if (result.code === 'LOCKED') setMessage(copy.locked);
      else if (result.code === 'SECURE_STORAGE_UNAVAILABLE') setMessage(copy.unavailable);
      else setMessage(copy.invalid);
    } catch {
      setMessage(copy.unavailable);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main
      className="relative flex h-full flex-col overflow-hidden bg-slate-100 p-4 text-slate-900"
      data-testid="customer-checkin-screen"
    >
      <div className="min-h-0 flex-1" data-testid="android-checkin-wizard-slot">{children}</div>
      <footer className="flex shrink-0 justify-end pt-2" data-testid="android-checkin-staff-footer">
        <button
          type="button"
          className="min-h-[44px] rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-500 shadow-sm"
          onClick={() => { setOpen(true); setMessage(null); }}
          data-testid="android-checkin-staff-exit"
        >
          {copy.staff}
        </button>
      </footer>
      {open && (
        <div
          className="fixed bottom-0 left-0 right-0 top-0 z-50 flex items-center justify-center bg-slate-950/50 p-5"
          role="dialog"
          aria-modal="true"
          aria-label={copy.title}
        >
          <form className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl" onSubmit={submit}>
            <h2 className="text-xl font-extrabold">{copy.title}</h2>
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              {copy.pin}
              <input
                autoFocus
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(event) => {
                  setPin(event.target.value.replace(/\D/g, '').slice(0, 8));
                  setMessage(null);
                }}
                className="mt-2 min-h-[52px] w-full rounded-lg border border-slate-300 px-4 text-center text-2xl font-bold tracking-[0.3em] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200"
              />
            </label>
            {message && <p className="mt-3 text-sm font-semibold text-red-700" role="alert">{message}</p>}
            <div className="mt-5 grid grid-cols-2">
              <button
                type="button"
                className="mr-2 min-h-[48px] rounded-lg border border-slate-300 font-bold text-slate-600"
                onClick={close}
                disabled={submitting}
              >
                {copy.cancel}
              </button>
              <button
                type="submit"
                className="ml-2 min-h-[48px] rounded-lg bg-blue-600 font-bold text-white disabled:opacity-60"
                disabled={submitting}
              >
                {copy.unlock}
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  );
}
