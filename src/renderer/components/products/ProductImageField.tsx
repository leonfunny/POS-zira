import React, { useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, Link, Package, Trash2 } from 'lucide-react';
import { getSharedEnvironmentCameraStream, releaseSharedEnvironmentCameraStream } from '../pos/camera-stream';
import Modal from '../shared/Modal';

export interface PendingProductImage {
  dataUrl: string;
  fileName: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  source: 'file' | 'camera';
}

interface ProductImageFieldProps {
  imageUrl: string;
  pendingImage: PendingProductImage | null;
  supportsUpload: boolean;
  showUrlError?: boolean;
  disabled?: boolean;
  t: (key: string) => string;
  onImageUrlChange: (value: string) => void;
  onPendingImageChange: (value: PendingProductImage | null) => void;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function tOr(t: (key: string) => string, key: string, fallback: string): string {
  const value = t(key);
  return value && value !== key ? value : fallback;
}

export function isProductCameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

export async function probeProductCamera(): Promise<boolean> {
  if (!isProductCameraAvailable() || !navigator.mediaDevices?.enumerateDevices) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === 'videoinput');
  } catch {
    return false;
  }
}

export function isValidProductImageUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

interface ProductCameraDialogProps {
  open: boolean;
  t: (key: string) => string;
  onClose: () => void;
  onCaptured: (image: PendingProductImage) => void;
}

function ProductCameraDialog({ open, t, onClose, onCaptured }: ProductCameraDialogProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setReady(false);
    setError(null);

    void getSharedEnvironmentCameraStream().then((stream) => {
      if (!active) {
        releaseSharedEnvironmentCameraStream();
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      return video.play().then(() => {
        if (active) setReady(video.readyState >= 2);
      });
    }).catch((cameraError: unknown) => {
      if (!active) return;
      setError(cameraError instanceof Error
        ? cameraError.message
        : tOr(tRef.current, 'products.media.cameraUnavailable', 'Camera is not available on this device'));
    });

    return () => {
      active = false;
      if (videoRef.current) videoRef.current.srcObject = null;
      streamRef.current = null;
      releaseSharedEnvironmentCameraStream();
    };
  }, [open]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !ready) return;
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      setError(tOr(t, 'products.media.captureFailed', 'Could not capture the photo'));
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    onCaptured({
      dataUrl: canvas.toDataURL('image/jpeg', 0.9),
      fileName: `product-${Date.now()}.jpg`,
      mimeType: 'image/jpeg',
      source: 'camera',
    });
    onClose();
  };

  return (
    <Modal
      open={open}
      zLayer="nested"
      size="lg"
      title={tOr(t, 'products.media.cameraTitle', 'Take product photo')}
      onClose={onClose}
      closeLabel={tOr(t, 'products.drawer.close', 'Close')}
      footer={(
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-100"
          >
            {tOr(t, 'products.edit.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={capture}
            disabled={!ready}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Camera size={17} />
            {tOr(t, 'products.media.capture', 'Take photo')}
          </button>
        </div>
      )}
    >
      <div className="p-4">
        <div className="relative aspect-video overflow-hidden rounded-lg border border-slate-200 bg-slate-950">
          <video
            ref={videoRef}
            muted
            playsInline
            onLoadedData={() => setReady(true)}
            className="h-full w-full object-contain"
          />
          {!ready && !error ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm font-medium text-white">
              {tOr(t, 'products.media.cameraStarting', 'Starting camera...')}
            </div>
          ) : null}
        </div>
        {error ? (
          <div role="alert" className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {error}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export default function ProductImageField({
  imageUrl,
  pendingImage,
  supportsUpload,
  showUrlError = true,
  disabled = false,
  t,
  onImageUrlChange,
  onPendingImageChange,
}: ProductImageFieldProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewUrl = pendingImage?.dataUrl || imageUrl.trim();
  const invalidImageUrl = showUrlError && !isValidProductImageUrl(imageUrl);

  useEffect(() => {
    let active = true;
    if (!supportsUpload || disabled) {
      setCameraAvailable(false);
      return undefined;
    }
    void probeProductCamera().then((available) => {
      if (active) setCameraAvailable(available);
    });
    return () => {
      active = false;
    };
  }, [disabled, supportsUpload]);

  useEffect(() => {
    setPreviewFailed(false);
  }, [previewUrl]);

  const selectFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setError(tOr(t, 'products.media.invalidFile', 'Choose a JPG, PNG, or WebP image'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(tOr(t, 'products.media.fileTooLarge', 'Image must be smaller than 10 MB'));
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      onPendingImageChange({
        dataUrl,
        fileName: file.name,
        mimeType: file.type as PendingProductImage['mimeType'],
        source: 'file',
      });
    } catch {
      setError(tOr(t, 'products.media.readFailed', 'Could not read the selected image'));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeImage = () => {
    setError(null);
    onPendingImageChange(null);
    onImageUrlChange('');
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50/70 p-4">
      <div className="mb-3">
        <h4 className="text-sm font-semibold text-slate-950">
          {tOr(t, 'products.media.title', 'Main image')}
        </h4>
        <p className="mt-1 text-xs text-slate-500">
          {tOr(t, 'products.media.description', 'Choose a local file, use a camera, or paste an image URL.')}
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="flex h-28 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-white text-slate-400">
          {previewUrl && !previewFailed ? (
            <img
              src={previewUrl}
              alt={tOr(t, 'products.media.previewAlt', 'Product image preview')}
              onError={() => setPreviewFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <Package size={34} />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(event) => void selectFile(event.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || !supportsUpload}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              title={!supportsUpload ? tOr(t, 'products.media.uploadUnavailable', 'Local image upload is unavailable') : undefined}
            >
              <ImagePlus size={17} />
              {tOr(t, 'products.media.chooseFile', 'Choose file')}
            </button>
            {cameraAvailable ? (
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                disabled={disabled || !supportsUpload}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Camera size={17} />
                {tOr(t, 'products.media.camera', 'Camera')}
              </button>
            ) : null}
            {previewUrl ? (
              <button
                type="button"
                onClick={removeImage}
                disabled={disabled}
                className="inline-flex h-11 items-center gap-2 rounded-md border border-rose-200 bg-white px-3 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
              >
                <Trash2 size={17} />
                {tOr(t, 'products.media.remove', 'Remove')}
              </button>
            ) : null}
          </div>

          <label className="block">
            <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-slate-500">
              <Link size={14} />
              {tOr(t, 'products.edit.imageUrl', 'Image URL')}
            </span>
            <input
              value={imageUrl}
              onChange={(event) => {
                onPendingImageChange(null);
                onImageUrlChange(event.target.value);
              }}
              disabled={disabled}
              maxLength={2048}
              placeholder="https://..."
              aria-invalid={invalidImageUrl}
              className={`h-11 w-full rounded-md border bg-white px-3 text-sm outline-none disabled:bg-slate-100 ${
                invalidImageUrl ? 'border-rose-300 focus:border-rose-500' : 'border-slate-300 focus:border-brand-500'
              }`}
            />
          </label>

          {invalidImageUrl ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {tOr(t, 'products.media.urlInvalid', 'Use a complete http:// or https:// image URL')}
            </div>
          ) : null}

          {pendingImage ? (
            <div role="status" className="rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-medium text-sky-800">
              {tOr(t, 'products.media.pending', 'Pending upload')}: {pendingImage.fileName}.{' '}
              {tOr(t, 'products.media.pendingHint', 'The image will upload when you save.')}
            </div>
          ) : null}
          {previewFailed ? (
            <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {tOr(t, 'products.media.previewFailed', 'The image URL could not be previewed. You can still save or replace it.')}
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
              {error}
            </div>
          ) : null}
        </div>
      </div>

      <ProductCameraDialog
        open={cameraOpen}
        t={t}
        onClose={() => setCameraOpen(false)}
        onCaptured={(image) => {
          setError(null);
          onPendingImageChange(image);
        }}
      />
    </section>
  );
}
