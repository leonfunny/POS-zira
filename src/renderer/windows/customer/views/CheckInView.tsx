import React, { useState, useEffect, useCallback, useRef } from 'react';

interface BookingSummary {
  id: number;
  customerName: string;
  serviceName: string;
  staffName: string;
  from: string;
  till: string;
  status: string;
}

interface UpsellItem {
  id: string;
  name: string;
  price: number;
  imageUrl?: string;
  description?: string;
}

type Step = 'welcome' | 'booking-search' | 'phone-search' | 'walkin' | 'upsell' | 'confirmed';

interface CheckInViewProps {
  t: (key: string) => string;
  salonName?: string;
  upsellItems?: UpsellItem[];
  onBrowseServices: () => void;
  onBack: () => void;
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatPrice(grosze: number): string {
  return (grosze / 100).toFixed(2);
}

export default function CheckInView({ t, salonName, upsellItems, onBrowseServices, onBack }: CheckInViewProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [bookings, setBookings] = useState<BookingSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [walkInName, setWalkInName] = useState('');
  const [phoneDigits, setPhoneDigits] = useState('');
  const [phoneResults, setPhoneResults] = useState<{ customers: any[]; bookings: BookingSummary[] } | null>(null);
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [selectedUpsells, setSelectedUpsells] = useState<string[]>([]);
  const [confirmedData, setConfirmedData] = useState<{
    customerName: string;
    customerPhone?: string;
    serviceName?: string;
    staffName?: string;
    bookingTime?: string;
    isWalkIn: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const upsellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset idle timer on any interaction (both local + main process)
  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    // Ping main process to reset its interaction timer too
    window.electronAPI.display?.ping?.();
    if (step !== 'confirmed' && step !== 'upsell') {
      idleTimerRef.current = setTimeout(() => {
        onBack();
      }, 30000);
    }
  }, [step, onBack]);

  useEffect(() => {
    resetIdleTimer();
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [step, resetIdleTimer]);

  // Auto-return from confirmed screen after 8s
  useEffect(() => {
    if (step === 'confirmed') {
      confirmTimerRef.current = setTimeout(() => {
        onBack();
      }, 8000);
    }
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, [step, onBack]);

  // Upsell auto-dismiss after 15s
  useEffect(() => {
    if (step === 'upsell') {
      upsellTimerRef.current = setTimeout(() => {
        finishCheckIn();
      }, 15000);
    }
    return () => {
      if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    };
  }, [step]);

  // Load bookings when entering booking search
  const handleBookingSearch = useCallback(async () => {
    resetIdleTimer();
    setStep('booking-search');
    setLoading(true);
    try {
      const data = await window.electronAPI.display.getBookings();
      setBookings(data || []);
    } catch {
      setBookings([]);
    } finally {
      setLoading(false);
    }
  }, [resetIdleTimer]);

  // Phone search
  const handlePhoneSearch = useCallback(async (digits: string) => {
    if (digits.length < 4) {
      setPhoneResults(null);
      return;
    }
    setPhoneLoading(true);
    try {
      const results = await window.electronAPI.display.searchByPhone(digits);
      setPhoneResults(results);
    } catch {
      setPhoneResults({ customers: [], bookings: [] });
    } finally {
      setPhoneLoading(false);
    }
  }, []);

  const handlePhoneDigit = (digit: string) => {
    resetIdleTimer();
    const newDigits = phoneDigits + digit;
    setPhoneDigits(newDigits);
    handlePhoneSearch(newDigits);
  };

  const handlePhoneBackspace = () => {
    resetIdleTimer();
    const newDigits = phoneDigits.slice(0, -1);
    setPhoneDigits(newDigits);
    if (newDigits.length >= 4) {
      handlePhoneSearch(newDigits);
    } else {
      setPhoneResults(null);
    }
  };

  // Filter bookings by search query
  const filteredBookings = searchQuery.trim()
    ? bookings.filter((b) =>
        b.customerName.toLowerCase().includes(searchQuery.toLowerCase()) &&
        (b.status === 'BOOKED' || b.status === 'PENDING'),
      )
    : bookings.filter((b) => b.status === 'BOOKED' || b.status === 'PENDING');

  // Transition to upsell or directly to confirmed
  const transitionAfterCheckIn = (data: typeof confirmedData) => {
    setConfirmedData(data);
    if (upsellItems && upsellItems.length > 0) {
      setStep('upsell');
    } else {
      setStep('confirmed');
    }
  };

  const finishCheckIn = () => {
    if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    // If upsells were selected, include them in check-in data
    if (selectedUpsells.length > 0 && confirmedData) {
      window.electronAPI.display.checkIn({
        ...confirmedData,
        upsellsAdded: selectedUpsells,
      } as any).catch(() => {});
    }
    setStep('confirmed');
  };

  // Check in with a booking
  const handleBookingCheckIn = useCallback(async (booking: BookingSummary) => {
    const data = {
      bookingId: booking.id,
      customerName: booking.customerName,
      serviceName: booking.serviceName,
      staffName: booking.staffName,
      bookingTime: formatTime(booking.from),
      isWalkIn: false,
    };
    await window.electronAPI.display.checkIn(data);
    transitionAfterCheckIn(data);
  }, [upsellItems]);

  // Check in with a phone-matched booking
  const handlePhoneBookingCheckIn = useCallback(async (booking: BookingSummary, phone: string) => {
    const data = {
      bookingId: booking.id,
      customerName: booking.customerName,
      customerPhone: phone,
      serviceName: booking.serviceName,
      staffName: booking.staffName,
      bookingTime: formatTime(booking.from),
      isWalkIn: false,
    };
    await window.electronAPI.display.checkIn(data);
    transitionAfterCheckIn(data);
  }, [upsellItems]);

  // Check in as walk-in
  const handleWalkInCheckIn = useCallback(async () => {
    if (!walkInName.trim()) return;
    const data = {
      customerName: walkInName.trim(),
      isWalkIn: true,
    };
    await window.electronAPI.display.checkIn(data);
    transitionAfterCheckIn(data);
  }, [walkInName, upsellItems]);

  const toggleUpsell = (id: string) => {
    resetIdleTimer();
    if (upsellTimerRef.current) clearTimeout(upsellTimerRef.current);
    // Reset upsell timer on interaction
    upsellTimerRef.current = setTimeout(() => {
      finishCheckIn();
    }, 15000);
    setSelectedUpsells((prev) =>
      prev.includes(id) ? prev.filter((u) => u !== id) : [...prev, id],
    );
  };

  const displayName = salonName || t('customer.brandName');

  // Step 1: Welcome screen
  if (step === 'welcome') {
    return (
      <div
        className="min-h-screen bg-black text-white flex items-center justify-center overflow-hidden relative"
        onPointerDown={resetIdleTimer}
      >
        {/* Background */}
        <div
          className="absolute inset-0 opacity-20 pointer-events-none"
          style={{
            background: 'linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%)',
          }}
        />

        <div className="relative z-10 text-center px-8 max-w-2xl w-full">
          {/* Salon name */}
          <h1 className="text-5xl font-bold mb-4 bg-gradient-to-r from-purple-400 via-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
            {displayName}
          </h1>
          <p className="text-3xl text-slate-300 mb-16">
            {t('checkin.welcome')}
          </p>

          {/* Main buttons */}
          <div className="grid grid-cols-3 gap-4 mb-8">
            <button
              onClick={handleBookingSearch}
              className="py-8 px-4 rounded-2xl bg-gradient-to-br from-purple-600 to-purple-800 hover:from-purple-500 hover:to-purple-700 transition-all active:scale-95 shadow-lg shadow-purple-900/40"
            >
              <div className="text-4xl mb-3">&#128203;</div>
              <div className="text-lg font-semibold">{t('checkin.iHaveBooking')}</div>
            </button>
            <button
              onClick={() => { resetIdleTimer(); setPhoneDigits(''); setPhoneResults(null); setStep('phone-search'); }}
              className="py-8 px-4 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 hover:from-blue-500 hover:to-blue-700 transition-all active:scale-95 shadow-lg shadow-blue-900/40"
            >
              <div className="text-4xl mb-3">&#128222;</div>
              <div className="text-lg font-semibold">{t('checkin.phoneSearch')}</div>
            </button>
            <button
              onClick={() => { resetIdleTimer(); setStep('walkin'); }}
              className="py-8 px-4 rounded-2xl bg-gradient-to-br from-emerald-600 to-emerald-800 hover:from-emerald-500 hover:to-emerald-700 transition-all active:scale-95 shadow-lg shadow-emerald-900/40"
            >
              <div className="text-4xl mb-3">&#128694;</div>
              <div className="text-lg font-semibold">{t('checkin.walkIn')}</div>
            </button>
          </div>

          {/* Browse services link */}
          <button
            onClick={onBrowseServices}
            className="px-8 py-4 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white transition-all text-lg"
          >
            &#128133; {t('checkin.browseServices')}
          </button>
        </div>
      </div>
    );
  }

  // Step: Phone search with numeric keypad
  if (step === 'phone-search') {
    const matchedBookings = phoneResults?.bookings?.filter(
      (b: any) => b.status === 'BOOKED' || b.status === 'PENDING',
    ) || [];

    return (
      <div
        className="min-h-screen bg-black text-white flex flex-col overflow-hidden"
        onPointerDown={resetIdleTimer}
      >
        {/* Header */}
        <div className="p-6 flex items-center gap-4 border-b border-slate-800">
          <button
            onClick={() => { setStep('welcome'); setPhoneDigits(''); setPhoneResults(null); }}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-lg"
          >
            &#8592; {t('checkin.back')}
          </button>
          <h2 className="text-2xl font-semibold text-slate-200">{t('checkin.phoneSearch')}</h2>
        </div>

        <div className="flex-1 flex gap-6 p-6">
          {/* Keypad */}
          <div className="w-80 shrink-0">
            {/* Display */}
            <div className="mb-4 px-6 py-4 bg-slate-900 border-2 border-slate-700 rounded-xl text-center">
              <span className="text-3xl font-mono tracking-wider">
                {phoneDigits || t('checkin.phonePlaceholder')}
              </span>
            </div>

            {/* Number pad */}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((key) => {
                if (key === '') return <div key="empty" />;
                if (key === 'del') {
                  return (
                    <button
                      key="del"
                      onClick={handlePhoneBackspace}
                      className="py-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-xl font-semibold active:scale-95 transition-all"
                    >
                      &#9003;
                    </button>
                  );
                }
                return (
                  <button
                    key={key}
                    onClick={() => handlePhoneDigit(key)}
                    className="py-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-2xl font-semibold active:scale-95 transition-all"
                  >
                    {key}
                  </button>
                );
              })}
            </div>

            {/* Continue as walk-in */}
            <button
              onClick={() => { setStep('walkin'); }}
              className="w-full mt-4 py-3 rounded-xl bg-slate-800/60 hover:bg-slate-700/60 text-slate-400 hover:text-white text-base transition-all"
            >
              {t('checkin.continueAsWalkIn')}
            </button>
          </div>

          {/* Results */}
          <div className="flex-1 overflow-y-auto">
            {phoneLoading && (
              <div className="text-center py-12 text-slate-500">
                <div className="inline-block w-8 h-8 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {!phoneLoading && phoneDigits.length >= 4 && matchedBookings.length === 0 && (
              <div className="text-center py-12 text-slate-500 text-xl">
                {t('checkin.noPhoneMatch')}
              </div>
            )}
            {matchedBookings.length > 0 && (
              <div className="grid gap-3">
                {matchedBookings.map((b: any) => (
                  <div
                    key={b.id}
                    className="flex items-center gap-4 p-5 bg-slate-900/80 border border-slate-800 rounded-xl hover:border-blue-600/50 transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xl font-semibold truncate">{b.customerName}</div>
                      <div className="text-base text-slate-400 mt-1 truncate">
                        {b.serviceName} &middot; {b.staffName}
                      </div>
                      <div className="text-sm text-slate-500 mt-1">
                        {formatTime(b.from)} - {formatTime(b.till)}
                      </div>
                    </div>
                    <button
                      onClick={() => handlePhoneBookingCheckIn(b, phoneDigits)}
                      className="px-6 py-3 rounded-xl bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 text-white font-semibold text-lg active:scale-95 transition-all shrink-0"
                    >
                      {t('checkin.imHere')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Step 2a: Booking search
  if (step === 'booking-search') {
    return (
      <div
        className="min-h-screen bg-black text-white flex flex-col overflow-hidden"
        onPointerDown={resetIdleTimer}
      >
        {/* Header */}
        <div className="p-6 flex items-center gap-4 border-b border-slate-800">
          <button
            onClick={() => { setStep('welcome'); setSearchQuery(''); }}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-lg"
          >
            &#8592; {t('checkin.back')}
          </button>
          <h2 className="text-2xl font-semibold text-slate-200">{t('checkin.searchName')}</h2>
        </div>

        {/* Search input */}
        <div className="px-6 py-4">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); resetIdleTimer(); }}
            placeholder={t('checkin.searchPlaceholder')}
            autoFocus
            className="w-full px-6 py-5 text-2xl bg-slate-900 border-2 border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-purple-500 transition-colors"
          />
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {loading ? (
            <div className="text-center py-12 text-slate-500 text-xl">
              <div className="inline-block w-8 h-8 border-2 border-slate-500 border-t-transparent rounded-full animate-spin mb-4" />
              <p>{t('pos.loading') || 'Loading...'}</p>
            </div>
          ) : filteredBookings.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-xl">
              {t('checkin.noResults')}
            </div>
          ) : (
            <div className="grid gap-3">
              {filteredBookings.map((b) => (
                <div
                  key={b.id}
                  className="flex items-center gap-4 p-5 bg-slate-900/80 border border-slate-800 rounded-xl hover:border-purple-600/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xl font-semibold truncate">{b.customerName}</div>
                    <div className="text-base text-slate-400 mt-1 truncate">
                      {b.serviceName} &middot; {b.staffName}
                    </div>
                    <div className="text-sm text-slate-500 mt-1">
                      {formatTime(b.from)} - {formatTime(b.till)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleBookingCheckIn(b)}
                    className="px-6 py-3 rounded-xl bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 text-white font-semibold text-lg active:scale-95 transition-all shrink-0"
                  >
                    {t('checkin.imHere')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Step 2b: Walk-in entry
  if (step === 'walkin') {
    return (
      <div
        className="min-h-screen bg-black text-white flex flex-col items-center justify-center overflow-hidden"
        onPointerDown={resetIdleTimer}
      >
        <div className="w-full max-w-xl px-8">
          {/* Back button */}
          <button
            onClick={() => { setStep('welcome'); setWalkInName(''); }}
            className="mb-8 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-lg"
          >
            &#8592; {t('checkin.back')}
          </button>

          <h2 className="text-3xl font-semibold text-slate-200 mb-8 text-center">
            {t('checkin.walkInName')}
          </h2>

          <input
            type="text"
            value={walkInName}
            onChange={(e) => { setWalkInName(e.target.value); resetIdleTimer(); }}
            placeholder={t('checkin.walkInPlaceholder')}
            autoFocus
            className="w-full px-6 py-5 text-2xl bg-slate-900 border-2 border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 transition-colors mb-6"
          />

          <button
            onClick={handleWalkInCheckIn}
            disabled={!walkInName.trim()}
            className="w-full py-5 rounded-xl bg-gradient-to-r from-emerald-600 to-emerald-700 hover:from-emerald-500 hover:to-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold text-xl active:scale-95 transition-all"
          >
            {t('checkin.checkInButton')}
          </button>
        </div>
      </div>
    );
  }

  // Step: Upsell screen
  if (step === 'upsell' && upsellItems && upsellItems.length > 0) {
    return (
      <div
        className="min-h-screen bg-black text-white flex flex-col items-center justify-center overflow-hidden relative"
        onPointerDown={resetIdleTimer}
      >
        <div
          className="absolute inset-0 opacity-10 pointer-events-none"
          style={{
            background: 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)',
          }}
        />

        <div className="relative z-10 w-full max-w-3xl px-8">
          <h2 className="text-3xl font-bold text-center mb-2 text-slate-200">
            {t('checkin.upsellTitle')}
          </h2>
          <p className="text-lg text-slate-400 text-center mb-8">
            {confirmedData?.customerName}
          </p>

          {/* Upsell cards */}
          <div className="grid grid-cols-2 gap-4 mb-8">
            {upsellItems.slice(0, 4).map((item) => {
              const isSelected = selectedUpsells.includes(item.id);
              return (
                <button
                  key={item.id}
                  onClick={() => toggleUpsell(item.id)}
                  className={`p-6 rounded-2xl border-2 text-left transition-all active:scale-95 ${
                    isSelected
                      ? 'border-purple-500 bg-purple-900/40'
                      : 'border-slate-700 bg-slate-900/60 hover:border-slate-500'
                  }`}
                >
                  {item.imageUrl && (
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      className="w-full h-24 object-cover rounded-lg mb-3"
                    />
                  )}
                  <div className="text-lg font-semibold truncate">{item.name}</div>
                  <div className="text-base text-purple-400 mt-1">
                    {formatPrice(item.price)} PLN
                  </div>
                  {isSelected && (
                    <div className="mt-2 text-sm text-purple-300 font-medium">
                      {t('checkin.upsellAdded')}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Skip / Continue */}
          <div className="flex gap-4 justify-center">
            <button
              onClick={finishCheckIn}
              className="px-8 py-4 rounded-xl bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 hover:text-white text-lg transition-all"
            >
              {t('checkin.upsellSkip')}
            </button>
            {selectedUpsells.length > 0 && (
              <button
                onClick={finishCheckIn}
                className="px-8 py-4 rounded-xl bg-gradient-to-r from-purple-600 to-fuchsia-600 hover:from-purple-500 hover:to-fuchsia-500 text-white font-semibold text-lg active:scale-95 transition-all"
              >
                {t('checkin.checkInButton')} ({selectedUpsells.length})
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Step 3: Confirmation
  if (step === 'confirmed' && confirmedData) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center overflow-hidden relative">
        {/* Success gradient background */}
        <div
          className="absolute inset-0 opacity-20 pointer-events-none"
          style={{
            background: 'radial-gradient(circle at center, #059669 0%, transparent 70%)',
          }}
        />

        <div className="relative z-10 text-center px-8">
          {/* Animated checkmark */}
          <div
            className="w-28 h-28 mx-auto mb-8 rounded-full bg-emerald-500/20 border-4 border-emerald-400 flex items-center justify-center"
            style={{ animation: 'scaleIn 0.4s ease-out' }}
          >
            <svg
              width="56"
              height="56"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-emerald-400"
              style={{ animation: 'drawCheck 0.5s ease-out 0.2s both' }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>

          <h1 className="text-5xl font-bold text-emerald-400 mb-4">
            {t('checkin.confirmed')}
          </h1>

          <p className="text-2xl text-slate-300 mb-6">
            {confirmedData.customerName}
          </p>

          {/* Booking details */}
          {confirmedData.serviceName && (
            <p className="text-xl text-slate-400 mb-2">
              {confirmedData.serviceName}
            </p>
          )}
          {confirmedData.staffName && (
            <p className="text-lg text-slate-500 mb-1">
              {t('checkin.withStaff').replace('{name}', confirmedData.staffName)}
            </p>
          )}
          {confirmedData.bookingTime && (
            <p className="text-lg text-slate-500 mb-1">
              {t('checkin.at').replace('{time}', confirmedData.bookingTime)}
            </p>
          )}

          <p className="text-xl text-slate-400 mt-8">
            {t('checkin.pleaseWait')}
          </p>
        </div>

        <style>{`
          @keyframes scaleIn {
            0% { transform: scale(0); opacity: 0; }
            100% { transform: scale(1); opacity: 1; }
          }
          @keyframes drawCheck {
            0% { stroke-dasharray: 30; stroke-dashoffset: 30; }
            100% { stroke-dasharray: 30; stroke-dashoffset: 0; }
          }
        `}</style>
      </div>
    );
  }

  // Fallback
  return null;
}
