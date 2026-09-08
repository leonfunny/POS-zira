import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from '../components/shared/Modal';
import Button from '../components/shared/Button';
import { getTranslation } from '../i18n/translations';

interface Feedback {
  body: string;
  confirmation: boolean;
  danger: boolean;
  resolve: (accepted: boolean) => void;
}

/** In-app replacement for blocking native messages and confirmations. */
export function useFeedbackDialog(t: (key: string) => string = getTranslation('en')) {
  const queue = useRef<Feedback[]>([]);
  const alive = useRef(true);
  const [current, setCurrent] = useState<Feedback | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queue.current.splice(0).forEach(item => item.resolve(false));
    };
  }, []);

  const request = useCallback((body: string, confirmation: boolean, danger = false) => {
    if (!alive.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      queue.current.push({ body, confirmation, danger, resolve });
      setCurrent(queue.current[0]);
    });
  }, []);
  const finish = useCallback((accepted: boolean) => {
    const item = queue.current.shift();
    setCurrent(queue.current[0] || null);
    item?.resolve(accepted);
  }, []);
  const message = useCallback((body: string) => request(body, false), [request]);
  const confirm = useCallback((body: string, danger = false) => request(body, true, danger), [request]);

  const dialog = current && createPortal(
    <Modal title={t(current.confirmation ? 'common.confirm' : 'common.notice')}
      zLayer="nested" overlayStyle={{ zIndex: 80 }} onClose={() => finish(false)} closeLabel={t('common.close')}
      footer={<div className="flex justify-end gap-2">
        {current.confirmation && <Button variant="secondary" onClick={() => finish(false)}>{t('common.cancel')}</Button>}
        <Button variant={current.danger ? 'danger' : 'primary'} onClick={() => finish(true)}>
          {t(current.confirmation ? 'common.confirm' : 'common.close')}
        </Button>
      </div>}
    >
      <p className="whitespace-pre-wrap break-words p-5 text-sm text-slate-800">{current.body}</p>
    </Modal>, document.body,
  );
  return { message, confirm, dialog };
}
