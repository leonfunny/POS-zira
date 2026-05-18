import React, { useEffect, useRef, useState } from 'react';

export interface QuickAddCapturedImage {
  dataUrl: string;
  mimeType: string;
}

export interface QuickAddPreparedResult {
  analysis: {
    name?: string;
    ean?: string;
    weight?: number;
    weightUnit?: string;
    [key: string]: any;
  };
  product: any;
  variant: any;
}

export interface QuickAddFinalizeInput {
  productId: string;
  variantId: string;
  name?: string;
  ean?: string | null;
  retailPriceGrosze: number;
  quantity: number;
  idempotencyKey: string;
}

interface QuickAddCameraModalProps {
  open: boolean;
  onClose: () => void;
  onPrepare: (images: QuickAddCapturedImage[], idempotencyKey: string) => Promise<QuickAddPreparedResult>;
  onFinalize: (input: QuickAddFinalizeInput) => Promise<void>;
  t: (key: string) => string;
}

export default function QuickAddCameraModal({
  open,
  onClose,
  onPrepare,
  onFinalize,
  t,
}: QuickAddCameraModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prepareIdempotencyKeyRef = useRef<string | null>(null);
  const finalizeIdempotencyKeyRef = useRef<string | null>(null);
  const [images, setImages] = useState<QuickAddCapturedImage[]>([]);
  const [prepared, setPrepared] = useState<QuickAddPreparedResult | null>(null);
  const [productName, setProductName] = useState('');
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tOr = (key: string, fallback: string) => {
    const v = t(key);
    return v && v !== key ? v : fallback;
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraReady(false);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setImages([]);
    setPrepared(null);
    setProductName('');
    setPrice('');
    setQuantity('1');
    setBusy(false);
    setCameraReady(false);
    setError(null);
    prepareIdempotencyKeyRef.current = crypto.randomUUID();
    finalizeIdempotencyKeyRef.current = crypto.randomUUID();

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    }).then((stream) => {
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play();
      }
    }).catch((err: any) => {
      setError(err?.message || tOr('pos.quickAdd.cameraUnavailable', 'Camera unavailable'));
    });

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open]);

  if (!open) return null;

  const handleCapture = () => {
    if (!videoRef.current || !canvasRef.current || images.length >= 3) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, width, height);
    const nextImage = { dataUrl: canvas.toDataURL('image/jpeg', 0.92), mimeType: 'image/jpeg' };
    setImages((prev) => (prev.length >= 3 ? prev : [...prev, nextImage]));
  };

  const handleAnalyze = async () => {
    if (images.length < 2) return;
    setBusy(true);
    setError(null);
    try {
      const result = await onPrepare(images, prepareIdempotencyKeyRef.current ?? crypto.randomUUID());
      setPrepared(result);
      setProductName(result.analysis?.name ?? '');
      stopCamera();
    } catch (err: any) {
      setError(err?.message || tOr('pos.quickAdd.analyzeFailed', 'Analyze failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleFinalize = async () => {
    if (!prepared?.product?.id || !prepared?.variant?.id) {
      setError(tOr('pos.quickAdd.missingIds', 'Missing created product ids'));
      return;
    }
    const priceGrosze = Math.round(Number(price || 0) * 100);
    const qty = Math.floor(Number(quantity || 0));
    const name = productName.trim();
    if (!name) {
      setError(tOr('pos.quickAdd.missingName', 'Enter a product name'));
      return;
    }
    if (!(priceGrosze > 0) || !(qty > 0)) {
      setError(tOr('pos.quickAdd.invalidPriceQty', 'Enter a valid price and quantity'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onFinalize({
        productId: prepared.product.id,
        variantId: prepared.variant.id,
        name,
        ean: prepared.analysis.ean ?? prepared.variant.barcode ?? null,
        retailPriceGrosze: priceGrosze,
        quantity: qty,
        idempotencyKey: finalizeIdempotencyKeyRef.current ?? crypto.randomUUID(),
      });
    } catch (err: any) {
      setError(err?.message || tOr('pos.quickAdd.saveFailed', 'Save failed'));
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (busy) return;
    if (
      prepared &&
      !window.confirm(tOr(
        'pos.quickAdd.confirmAbandon',
        'This product was already created. Close anyway and leave price/stock unfinished?',
      ))
    ) {
      return;
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75" onClick={busy ? undefined : requestClose}>
      <div className="w-full max-w-4xl mx-4 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 text-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-4">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">
              {tOr('pos.quickAdd.title', 'Quick add by camera')}
            </div>
            <div className="mt-1 text-sm text-slate-300">
              {prepared
                ? tOr('pos.quickAdd.review', 'Review product, then enter price and stock')
                : tOr('pos.quickAdd.captureHint', 'Capture 2–3 photos: front, barcode, side')}
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            className="h-10 w-10 rounded-full text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-50"
          >
            ×
          </button>
        </div>

        {!prepared ? (
          <div className="grid gap-4 p-5 md:grid-cols-[minmax(0,1fr)_240px]">
            <div className="relative overflow-hidden rounded-xl border border-slate-700 bg-black">
              <video
                ref={videoRef}
                muted
                playsInline
                onLoadedMetadata={() => setCameraReady(true)}
                className="aspect-video h-full w-full object-cover"
              />
              {!cameraReady && !error && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
                  {tOr('pos.quickAdd.cameraStarting', 'Starting camera…')}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: 3 }).map((_, index) => {
                  const image = images[index];
                  return image ? (
                    <div key={index} className="relative overflow-hidden rounded-lg border border-slate-700">
                      <img src={image.dataUrl} alt={`capture-${index + 1}`} className="aspect-square h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
                        disabled={busy}
                        className="absolute right-1 top-1 h-7 w-7 rounded-full bg-black/70 text-sm"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <div key={index} className="flex aspect-square items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
                      {index + 1}
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={handleCapture}
                disabled={!cameraReady || busy || images.length >= 3}
                className="h-12 rounded-lg bg-white font-bold text-slate-900 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {tOr('pos.quickAdd.capture', 'Capture photo')}
              </button>
              <button
                type="button"
                onClick={handleAnalyze}
                disabled={busy || images.length < 2}
                className="h-12 rounded-lg bg-emerald-600 font-bold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? tOr('pos.quickAdd.analyzing', 'Analyzing…') : tOr('pos.quickAdd.send', 'Send photos')}
              </button>
              <div className="text-xs leading-relaxed text-slate-400">
                {tOr('pos.quickAdd.photoRule', 'Minimum 2 photos, maximum 3 photos.')}
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 p-5 md:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-2">
              <img src={images[0]?.dataUrl} alt={prepared.analysis.name || 'product'} className="aspect-square w-full rounded-xl border border-slate-700 object-cover" />
              <div className="grid grid-cols-3 gap-2">
                {images.map((image, index) => (
                  <img key={index} src={image.dataUrl} alt={`capture-${index + 1}`} className="aspect-square rounded-lg border border-slate-700 object-cover" />
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block">
                  <span className="text-xs font-medium text-slate-400">{tOr('pos.quickAdd.productName', 'Product name')}</span>
                  <input
                    value={productName}
                    onChange={(e) => setProductName(e.target.value)}
                    className="mt-1 h-12 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-lg font-bold text-white outline-none focus:border-emerald-500"
                  />
                </label>
                {prepared.analysis.nameNeedsReview ? (
                  <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-100">
                    {tOr('pos.quickAdd.nameNeedsReview', 'AI could not read a reliable name. Check the name before saving.')}
                  </div>
                ) : null}
                <div className="mt-3 text-sm text-slate-400">
                  EAN: {prepared.analysis.ean || '—'}
                  {prepared.analysis.weight != null ? ` · ${prepared.analysis.weight} ${prepared.analysis.weightUnit || ''}` : ''}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-400">{tOr('pos.quickAdd.retailPrice', 'Retail price')}</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={price}
                    onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setPrice(e.target.value); }}
                    placeholder="0.00"
                    className="h-12 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 text-right text-lg font-bold outline-none focus:border-emerald-500"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-medium text-slate-400">{tOr('pos.quickAdd.quantity', 'Stock quantity')}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={quantity}
                    onChange={(e) => { if (/^\d*$/.test(e.target.value)) setQuantity(e.target.value); }}
                    placeholder="1"
                    className="h-12 w-full rounded-lg border border-slate-600 bg-slate-800 px-3 text-right text-lg font-bold outline-none focus:border-emerald-500"
                  />
                </label>
              </div>

              <div className="space-y-3">
                <div className="rounded-lg border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-sm text-amber-100">
                  {tOr('pos.quickAdd.finishHint', 'Product created. Finish price and stock before leaving this step.')}
                </div>
                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={busy}
                  className="h-12 w-full rounded-lg bg-emerald-600 font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busy ? tOr('pos.quickAdd.saving', 'Saving…') : tOr('pos.quickAdd.saveAndAdd', 'Save + add to cart')}
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="mx-5 mb-5 rounded-lg border border-red-500/30 bg-red-950/50 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
}

