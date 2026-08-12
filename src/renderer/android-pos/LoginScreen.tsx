/**
 * Android staff login screen (packet S6+S7).
 *
 * The Windows POS window never logs in — the desktop main window does and the
 * POS window inherits the identity from config (SHIM_CONTRACT_S1.md §0.1). On
 * Android the shim/shell owns login, so this minimal screen fronts the shim's
 * `auth.loginWithEmail` (staff email/password → staff JWT; never the `pa_`
 * key). It lives in the android-pos directory only — the Windows renderer is
 * untouched.
 */

import React, { useState } from 'react';

interface LoginScreenProps {
  onLoggedIn: (user: Record<string, unknown> | null) => void;
}

export default function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const api = (window as any).electronAPI;
      const result = await api.auth.loginWithEmail(email.trim(), password);
      if (result?.success) {
        onLoggedIn(result?.data?.user ?? null);
      } else {
        setError(result?.error || 'Đăng nhập thất bại');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm bg-white rounded-2xl shadow-lg p-8 space-y-4"
      >
        <div className="text-center space-y-1">
          <div className="text-2xl font-bold text-gray-900">Zira POS</div>
          <div className="text-sm text-gray-500">Đăng nhập nhân viên</div>
        </div>
        <label className="block">
          <span className="text-sm text-gray-700">Email, số điện thoại hoặc tên đăng nhập</span>
          {/* Not type="email": the backend accepts an email, a phone number or a
              plain username (LoginDto validates none of them). A type="email"
              input made the WebView block usernames before the request was ever
              sent. inputMode keeps the @-bearing keyboard on a tablet. */}
          <input
            type="text"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-3 text-base"
            placeholder="tên đăng nhập / +48 500 100 200 / staff@salon.pl"
          />
        </label>
        <label className="block">
          <span className="text-sm text-gray-700">Mật khẩu</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-3 text-base"
          />
        </label>
        {error ? (
          <div role="alert" className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            {error}
          </div>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-gray-900 text-white py-3 text-base font-semibold disabled:opacity-50"
        >
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
    </div>
  );
}
