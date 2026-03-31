/**
 * Delete Confirmation Modal
 *
 * Requires entering a confirmation code before delete operations.
 * Code is controlled by SuperAdmin (default: 123456).
 */

import React, { useState, useEffect, useRef } from 'react';

interface DeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message?: string;
  itemName?: string;
}

export default function DeleteConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title = 'Confirm Delete',
  message = 'Enter the confirmation code to delete this item.',
  itemName,
}: DeleteConfirmModalProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setCode('');
      setError(null);
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsVerifying(true);

    try {
      const result = await window.electronAPI.deleteConfirm.verify(code);

      if (result.valid) {
        onConfirm();
        onClose();
      } else {
        setError('Invalid code. Please try again.');
        setCode('');
        inputRef.current?.focus();
      }
    } catch (err) {
      setError('Failed to verify code. Please try again.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="bg-red-50 border-b border-red-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-red-900">{title}</h2>
              {itemName && (
                <p className="text-sm text-red-600 truncate max-w-[280px]">
                  {itemName}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6">
          <p className="text-sm text-slate-600 mb-4">{message}</p>

          <div className="mb-4">
            <label htmlFor="delete-code" className="block text-sm font-medium text-slate-700 mb-1">
              Confirmation Code
            </label>
            <input
              ref={inputRef}
              id="delete-code"
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter 6-digit code"
              className={`w-full px-4 py-3 border rounded-xl text-center text-2xl tracking-[0.5em] font-mono transition-colors ${
                error
                  ? 'border-red-300 bg-red-50 focus:border-red-500 focus:ring-red-200'
                  : 'border-slate-200 focus:border-brand-500 focus:ring-brand-200'
              } focus:outline-none focus:ring-2`}
              maxLength={6}
              autoComplete="off"
              disabled={isVerifying}
            />
            {error && (
              <p className="mt-2 text-sm text-red-600 flex items-center gap-1">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                {error}
              </p>
            )}
          </div>

          {/* Buttons */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
              disabled={isVerifying}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={code.length < 6 || isVerifying}
              className="flex-1 px-4 py-2.5 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isVerifying ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  Verifying...
                </span>
              ) : (
                'Delete'
              )}
            </button>
          </div>
        </form>

        {/* Footer hint */}
        <div className="bg-slate-50 border-t border-slate-100 px-6 py-3">
          <p className="text-xs text-slate-400 text-center">
            Contact your administrator if you forgot the confirmation code.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Hook to use delete confirmation modal
 */
export function useDeleteConfirm() {
  const [isOpen, setIsOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    title?: string;
    message?: string;
    itemName?: string;
    onConfirm: () => void;
  } | null>(null);

  const confirmDelete = (options: {
    title?: string;
    message?: string;
    itemName?: string;
    onConfirm: () => void;
  }) => {
    setPendingDelete(options);
    setIsOpen(true);
  };

  const handleClose = () => {
    setIsOpen(false);
    setPendingDelete(null);
  };

  const handleConfirm = () => {
    if (pendingDelete?.onConfirm) {
      pendingDelete.onConfirm();
    }
    handleClose();
  };

  const DeleteModal = () => (
    <DeleteConfirmModal
      isOpen={isOpen}
      onClose={handleClose}
      onConfirm={handleConfirm}
      title={pendingDelete?.title}
      message={pendingDelete?.message}
      itemName={pendingDelete?.itemName}
    />
  );

  return {
    confirmDelete,
    DeleteModal,
  };
}
