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
        color: { dark: '#000000', light: '#ffffff' },
      }).catch((err: Error) => {
        rlog.error('[ThankYouView] QR code generation failed:', err);
      });
    }
  }, [bookingUrl]);

  return (
    <div className="text-center animate-fadeIn">
      <div className="text-6xl mb-6">✓</div>
      <h1 className="text-5xl font-bold mb-4">{t('customer.thankYou')}</h1>
      {lastOrderTotal != null && lastOrderTotal > 0 && (
        <p className="text-3xl text-slate-400">
          {new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' }).format(lastOrderTotal / 100)}
        </p>
      )}
      <p className="text-lg text-slate-500 mt-4">{t('customer.comeAgain')}</p>

      {bookingUrl && (
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="text-lg text-purple-300 font-medium">
            {t('customer.bookNext') || 'Book your next visit'}
          </p>
          <div className="bg-white rounded-xl p-3">
            <canvas ref={canvasRef} className="w-40 h-40" />
          </div>
          <p className="text-sm text-slate-500">
            {t('customer.scanToBook') || 'Scan to book online'}
          </p>
        </div>
      )}
    </div>
  );
}
