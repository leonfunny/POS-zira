// Full-screen overlay shown after the customer requests staff help. The
// terminal remains locked until staff resolves the request.
import React from 'react';
import { Hand, UserRoundCheck } from 'lucide-react';
import { ScLanguage, getScStrings } from '../i18n';

interface HelpLockedOverlayProps {
  lang: ScLanguage;
  acknowledged: boolean;
  reason: string;
  onCancel?: () => void;
}

export default function HelpLockedOverlay({
  lang,
  acknowledged,
  reason,
  onCancel,
}: HelpLockedOverlayProps) {
  const t = getScStrings(lang);
  const reasonLabel = reason === 'OTHER' ? t.helpReasonOther : reason;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#fff8ea] px-8 text-center select-none">
      <div className="flex h-32 w-32 items-center justify-center rounded-[34px] bg-amber-100 text-amber-800">
        {acknowledged ? <UserRoundCheck size={72} /> : <Hand size={72} />}
      </div>
      <h1 className="mt-8 max-w-4xl text-6xl font-black tracking-tight text-amber-950">
        {acknowledged ? t.staffComingTitle : t.staffCalledTitle}
      </h1>
      <p className="mt-5 text-2xl font-bold text-amber-800">{reasonLabel}</p>
      <p className="mt-3 max-w-2xl text-xl leading-8 text-amber-700">
        {acknowledged ? t.staffComingBody : t.staffLockedBody}
      </p>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="sc-secondary-action sc-focusable mt-10 px-8 text-lg"
        >
          {t.cancel}
        </button>
      )}
    </div>
  );
}
