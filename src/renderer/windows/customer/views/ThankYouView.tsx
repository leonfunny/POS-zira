import React, { useRef, useEffect } from 'react';
import QRCode from 'qrcode';
import rlog from '../../../utils/logger';

interface ThankYouViewProps {
  lastOrderTotal?: number;
  t: (key: string) => string;
  bookingUrl?: string;
}

export default function ThankYouView({ lastOrderTotal, t, bookingUrl }: ThankYouViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current && bookingUrl) {
      QRCode.toCanvas(canvasRef.current, bookingUrl, {
        width: 160,
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
      }).catch((err: Error) => {
        rlog.error('[ThankYouView] QR code generation failed:', err);
      });
    }
  }, [bookingUrl]);

  return (
    <div className="text-center animate-fadeIn px-8">
      <div className="mx-auto mb-8 w-24 h-24 rounded-full bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center">
        <svg className="w-12 h-12 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h1 className="text-6xl font-bold mb-5 text-slate-900">{t('customer.thankYou')}</h1>
      {lastOrderTotal != null && lastOrderTotal > 0 && (
        <p className="text-4xl text-brand-600 font-semibold tabular-nums mb-3">
          {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(lastOrderTotal / 100)}
        </p>
      )}
      <p className="text-xl text-slate-500 mt-4">{t('customer.comeAgain')}</p>

      {bookingUrl && (
        <div className="mt-10 flex flex-col items-center gap-3">
          <p className="text-lg text-brand-600 font-medium">
            {t('customer.bookNext') || 'Book your next visit'}
          </p>
          <div className="bg-white rounded-2xl p-4 shadow-md border border-slate-100">
            <canvas ref={canvasRef} className="w-40 h-40" />
          </div>
          <p className="text-sm text-slate-400">
            {t('customer.scanToBook') || 'Scan to book online'}
          </p>
        </div>
      )}
    </div>
  );
}
