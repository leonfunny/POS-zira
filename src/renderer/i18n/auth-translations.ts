/**
 * Auth/Welcome screen translations
 * Auto-detects Windows system language
 */

import { Language } from './translations';

export const authTranslations: Record<Language, Record<string, string>> = {
  en: {
    // Hero section
    'auth.badge': 'Desktop Print Agent',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'AI for managing your business',

    // Features
    'auth.feature1.title': 'Connect in seconds',
    'auth.feature1.desc': 'Scan the Telegram QR to pair your salon account securely.',
    'auth.feature2.title': 'Instant device sync',
    'auth.feature2.desc': 'Thermal printers and barcode scanners stay in sync with POS.',
    'auth.feature3.title': 'Local-first fallback',
    'auth.feature3.desc': 'Keep working even when the server is offline.',

    // Tags
    'auth.tag1': 'Secure pairing',
    'auth.tag2': 'POS + printer ready',
    'auth.tag3': 'Windows 10/11',

    // Sign in section
    'auth.signIn': 'Sign in',
    'auth.welcome': 'Welcome back',
    'auth.welcomeDesc': 'Use Telegram QR or email to continue.',

    // Telegram
    'auth.telegram.title': 'Sign in with Telegram',
    'auth.telegram.scan': 'Scan the QR code in Telegram',
    'auth.telegram.open': 'Open in Telegram',
    'auth.telegram.waiting': 'Waiting for confirmation',
    'auth.telegram.verified': 'Signed in!',
    'auth.telegram.expired': 'Code expired',
    'auth.telegram.tryAgain': 'Try again',

    // Email
    'auth.identifier.label': 'Email, phone or username',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / you@email.com',
    'auth.password.label': 'Password',
    'auth.password.placeholder': 'Password',
    'auth.signInButton': 'Sign in',
    'auth.signingIn': 'Signing in...',

    // Register
    'auth.noAccount': 'No account?',
    'auth.register': 'Register via Telegram',

    // Offline
    'auth.or': 'or',
    'auth.offlineMode': 'Offline mode (no server)',
    'auth.offlineDesc': 'Use POS locally without a server connection.',

    // Status
    'auth.serverChecking': 'Checking...',
    'auth.serverOnline': 'Server online',
    'auth.serverOffline': 'Server offline',
    'auth.serverUnknown': 'Unknown status',
    'auth.check': 'Check',
  },

  vi: {
    'auth.badge': 'Ứng dụng In Desktop',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'AI quản lý doanh nghiệp của bạn',

    'auth.feature1.title': 'Kết nối trong vài giây',
    'auth.feature1.desc': 'Quét mã QR Telegram để ghép nối tài khoản salon an toàn.',
    'auth.feature2.title': 'Đồng bộ thiết bị tức thì',
    'auth.feature2.desc': 'Máy in nhiệt và máy quét mã vạch luôn đồng bộ với POS.',
    'auth.feature3.title': 'Hoạt động offline',
    'auth.feature3.desc': 'Tiếp tục làm việc ngay cả khi mất kết nối server.',

    'auth.tag1': 'Ghép nối an toàn',
    'auth.tag2': 'Sẵn sàng POS + máy in',
    'auth.tag3': 'Windows 10/11',

    'auth.signIn': 'Đăng nhập',
    'auth.welcome': 'Chào mừng trở lại',
    'auth.welcomeDesc': 'Sử dụng Telegram QR hoặc email để tiếp tục.',

    'auth.telegram.title': 'Đăng nhập bằng Telegram',
    'auth.telegram.scan': 'Quét mã QR trong Telegram',
    'auth.telegram.open': 'Mở trong Telegram',
    'auth.telegram.waiting': 'Đang chờ xác nhận',
    'auth.telegram.verified': 'Đã đăng nhập!',
    'auth.telegram.expired': 'Mã đã hết hạn',
    'auth.telegram.tryAgain': 'Thử lại',

    'auth.identifier.label': 'Email, số điện thoại hoặc tên đăng nhập',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / you@email.com',
    'auth.password.label': 'Mật khẩu',
    'auth.password.placeholder': 'Mật khẩu',
    'auth.signInButton': 'Đăng nhập',
    'auth.signingIn': 'Đang đăng nhập...',

    'auth.noAccount': 'Chưa có tài khoản?',
    'auth.register': 'Đăng ký qua Telegram',

    'auth.or': 'hoặc',
    'auth.offlineMode': 'Chế độ offline (không server)',
    'auth.offlineDesc': 'Sử dụng POS cục bộ mà không cần kết nối server.',

    'auth.serverChecking': 'Đang kiểm tra...',
    'auth.serverOnline': 'Server online',
    'auth.serverOffline': 'Server offline',
    'auth.serverUnknown': 'Không rõ trạng thái',
    'auth.check': 'Kiểm tra',
  },

  pl: {
    'auth.badge': 'Aplikacja drukowania',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'AI do zarządzania Twoją firmą',

    'auth.feature1.title': 'Połącz w kilka sekund',
    'auth.feature1.desc': 'Zeskanuj kod QR w Telegramie, aby bezpiecznie sparować konto.',
    'auth.feature2.title': 'Natychmiastowa synchronizacja',
    'auth.feature2.desc': 'Drukarki termiczne i skanery są zawsze zsynchronizowane z POS.',
    'auth.feature3.title': 'Tryb offline',
    'auth.feature3.desc': 'Kontynuuj pracę nawet bez połączenia z serwerem.',

    'auth.tag1': 'Bezpieczne parowanie',
    'auth.tag2': 'POS + drukarka gotowe',
    'auth.tag3': 'Windows 10/11',

    'auth.signIn': 'Zaloguj się',
    'auth.welcome': 'Witaj ponownie',
    'auth.welcomeDesc': 'Użyj kodu QR Telegram lub email, aby kontynuować.',

    'auth.telegram.title': 'Zaloguj przez Telegram',
    'auth.telegram.scan': 'Zeskanuj kod QR w Telegramie',
    'auth.telegram.open': 'Otwórz w Telegramie',
    'auth.telegram.waiting': 'Oczekiwanie na potwierdzenie',
    'auth.telegram.verified': 'Zalogowano!',
    'auth.telegram.expired': 'Kod wygasł',
    'auth.telegram.tryAgain': 'Spróbuj ponownie',

    'auth.identifier.label': 'E-mail, telefon lub nazwa użytkownika',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / ty@email.com',
    'auth.password.label': 'Hasło',
    'auth.password.placeholder': 'Hasło',
    'auth.signInButton': 'Zaloguj się',
    'auth.signingIn': 'Logowanie...',

    'auth.noAccount': 'Nie masz konta?',
    'auth.register': 'Zarejestruj przez Telegram',

    'auth.or': 'lub',
    'auth.offlineMode': 'Tryb offline (bez serwera)',
    'auth.offlineDesc': 'Używaj POS lokalnie bez połączenia z serwerem.',

    'auth.serverChecking': 'Sprawdzanie...',
    'auth.serverOnline': 'Serwer online',
    'auth.serverOffline': 'Serwer offline',
    'auth.serverUnknown': 'Nieznany status',
    'auth.check': 'Sprawdź',
  },

  ru: {
    'auth.badge': 'Приложение для печати',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'ИИ для управления вашим бизнесом',

    'auth.feature1.title': 'Подключение за секунды',
    'auth.feature1.desc': 'Отсканируйте QR-код Telegram для безопасного подключения.',
    'auth.feature2.title': 'Мгновенная синхронизация',
    'auth.feature2.desc': 'Термопринтеры и сканеры всегда синхронизированы с POS.',
    'auth.feature3.title': 'Работа офлайн',
    'auth.feature3.desc': 'Продолжайте работу даже без подключения к серверу.',

    'auth.tag1': 'Безопасное подключение',
    'auth.tag2': 'POS + принтер готовы',
    'auth.tag3': 'Windows 10/11',

    'auth.signIn': 'Войти',
    'auth.welcome': 'С возвращением',
    'auth.welcomeDesc': 'Используйте Telegram QR или email для входа.',

    'auth.telegram.title': 'Войти через Telegram',
    'auth.telegram.scan': 'Отсканируйте QR-код в Telegram',
    'auth.telegram.open': 'Открыть в Telegram',
    'auth.telegram.waiting': 'Ожидание подтверждения',
    'auth.telegram.verified': 'Вход выполнен!',
    'auth.telegram.expired': 'Код истёк',
    'auth.telegram.tryAgain': 'Попробовать снова',

    'auth.identifier.label': 'Email, телефон или имя пользователя',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / вы@email.com',
    'auth.password.label': 'Пароль',
    'auth.password.placeholder': 'Пароль',
    'auth.signInButton': 'Войти',
    'auth.signingIn': 'Вход...',

    'auth.noAccount': 'Нет аккаунта?',
    'auth.register': 'Регистрация через Telegram',

    'auth.or': 'или',
    'auth.offlineMode': 'Офлайн режим (без сервера)',
    'auth.offlineDesc': 'Используйте POS локально без подключения к серверу.',

    'auth.serverChecking': 'Проверка...',
    'auth.serverOnline': 'Сервер онлайн',
    'auth.serverOffline': 'Сервер офлайн',
    'auth.serverUnknown': 'Статус неизвестен',
    'auth.check': 'Проверить',
  },

  uk: {
    'auth.badge': 'Додаток для друку',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'ШІ для керування вашим бізнесом',

    'auth.feature1.title': 'Підключення за секунди',
    'auth.feature1.desc': 'Відскануйте QR-код Telegram для безпечного підключення.',
    'auth.feature2.title': 'Миттєва синхронізація',
    'auth.feature2.desc': 'Термопринтери та сканери завжди синхронізовані з POS.',
    'auth.feature3.title': 'Робота офлайн',
    'auth.feature3.desc': 'Продовжуйте роботу навіть без підключення до сервера.',

    'auth.tag1': 'Безпечне підключення',
    'auth.tag2': 'POS + принтер готові',
    'auth.tag3': 'Windows 10/11',

    'auth.signIn': 'Увійти',
    'auth.welcome': 'З поверненням',
    'auth.welcomeDesc': 'Використовуйте Telegram QR або email для входу.',

    'auth.telegram.title': 'Увійти через Telegram',
    'auth.telegram.scan': 'Відскануйте QR-код у Telegram',
    'auth.telegram.open': 'Відкрити в Telegram',
    'auth.telegram.waiting': 'Очікування підтвердження',
    'auth.telegram.verified': 'Вхід виконано!',
    'auth.telegram.expired': 'Код закінчився',
    'auth.telegram.tryAgain': 'Спробувати знову',

    'auth.identifier.label': 'Email, телефон або ім\'я користувача',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / ви@email.com',
    'auth.password.label': 'Пароль',
    'auth.password.placeholder': 'Пароль',
    'auth.signInButton': 'Увійти',
    'auth.signingIn': 'Вхід...',

    'auth.noAccount': 'Немає облікового запису?',
    'auth.register': 'Реєстрація через Telegram',

    'auth.or': 'або',
    'auth.offlineMode': 'Офлайн режим (без сервера)',
    'auth.offlineDesc': 'Використовуйте POS локально без підключення до сервера.',

    'auth.serverChecking': 'Перевірка...',
    'auth.serverOnline': 'Сервер онлайн',
    'auth.serverOffline': 'Сервер офлайн',
    'auth.serverUnknown': 'Статус невідомий',
    'auth.check': 'Перевірити',
  },

  zh: {
    'auth.badge': '桌面打印代理',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'AI管理您的业务',

    'auth.feature1.title': '秒速连接',
    'auth.feature1.desc': '扫描Telegram二维码安全配对您的账户。',
    'auth.feature2.title': '即时设备同步',
    'auth.feature2.desc': '热敏打印机和条码扫描器与POS保持同步。',
    'auth.feature3.title': '离线优先',
    'auth.feature3.desc': '即使服务器离线也能继续工作。',

    'auth.tag1': '安全配对',
    'auth.tag2': 'POS + 打印机就绪',
    'auth.tag3': 'Windows 10/11',

    'auth.signIn': '登录',
    'auth.welcome': '欢迎回来',
    'auth.welcomeDesc': '使用Telegram二维码或邮箱继续。',

    'auth.telegram.title': '使用Telegram登录',
    'auth.telegram.scan': '在Telegram中扫描二维码',
    'auth.telegram.open': '在Telegram中打开',
    'auth.telegram.waiting': '等待确认',
    'auth.telegram.verified': '登录成功！',
    'auth.telegram.expired': '二维码已过期',
    'auth.telegram.tryAgain': '重试',

    'auth.identifier.label': '邮箱、电话或用户名',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / you@email.com',
    'auth.password.label': '密码',
    'auth.password.placeholder': '密码',
    'auth.signInButton': '登录',
    'auth.signingIn': '登录中...',

    'auth.noAccount': '没有账户？',
    'auth.register': '通过Telegram注册',

    'auth.or': '或',
    'auth.offlineMode': '离线模式（无服务器）',
    'auth.offlineDesc': '在没有服务器连接的情况下本地使用POS。',

    'auth.serverChecking': '检查中...',
    'auth.serverOnline': '服务器在线',
    'auth.serverOffline': '服务器离线',
    'auth.serverUnknown': '状态未知',
    'auth.check': '检查',
  },

  tr: {
    'auth.badge': 'Masaüstü Yazdırma Aracı',
    'auth.brand': 'ZIRA',
    'auth.brandAccent': '-',
    'auth.brandSuffix': 'AI',
    'auth.tagline': 'İşletmenizi yöneten yapay zeka',

    'auth.feature1.title': 'Saniyeler içinde bağlanın',
    'auth.feature1.desc': 'Hesabınızı güvenle eşleştirmek için Telegram QR kodunu tarayın.',
    'auth.feature2.title': 'Anında cihaz senkronizasyonu',
    'auth.feature2.desc': 'Termal yazıcılar ve barkod okuyucular POS ile senkronize kalır.',
    'auth.feature3.title': 'Çevrimdışı çalışma',
    'auth.feature3.desc': 'Sunucu çevrimdışı olsa bile çalışmaya devam edin.',

    'auth.tag1': 'Güvenli eşleştirme',
    'auth.tag2': 'POS + yazıcı hazır',
    'auth.tag3': 'Windows 10/11',

    'auth.signIn': 'Giriş yap',
    'auth.welcome': 'Tekrar hoş geldiniz',
    'auth.welcomeDesc': 'Devam etmek için Telegram QR veya e-posta kullanın.',

    'auth.telegram.title': 'Telegram ile giriş yap',
    'auth.telegram.scan': 'Telegram\'da QR kodunu tarayın',
    'auth.telegram.open': 'Telegram\'da aç',
    'auth.telegram.waiting': 'Onay bekleniyor',
    'auth.telegram.verified': 'Giriş yapıldı!',
    'auth.telegram.expired': 'Kod süresi doldu',
    'auth.telegram.tryAgain': 'Tekrar dene',

    'auth.identifier.label': 'E-posta, telefon veya kullanıcı adı',
    'auth.identifier.placeholder': 'baohan / +48 500 100 200 / siz@email.com',
    'auth.password.label': 'Şifre',
    'auth.password.placeholder': 'Şifre',
    'auth.signInButton': 'Giriş yap',
    'auth.signingIn': 'Giriş yapılıyor...',

    'auth.noAccount': 'Hesabınız yok mu?',
    'auth.register': 'Telegram ile kayıt ol',

    'auth.or': 'veya',
    'auth.offlineMode': 'Çevrimdışı mod (sunucusuz)',
    'auth.offlineDesc': 'POS\'u sunucu bağlantısı olmadan yerel olarak kullanın.',

    'auth.serverChecking': 'Kontrol ediliyor...',
    'auth.serverOnline': 'Sunucu çevrimiçi',
    'auth.serverOffline': 'Sunucu çevrimdışı',
    'auth.serverUnknown': 'Durum bilinmiyor',
    'auth.check': 'Kontrol et',
  },
};

/**
 * Detect Windows system language and map to supported language
 */
export function detectSystemLanguage(): Language {
  // Get browser/system language
  const systemLang = navigator.language || (navigator as any).userLanguage || 'en';
  const langCode = systemLang.toLowerCase().split('-')[0];

  // Map to supported languages
  const langMap: Record<string, Language> = {
    'en': 'en',
    'vi': 'vi',
    'pl': 'pl',
    'ru': 'ru',
    'uk': 'uk',
    'zh': 'zh',
    'tr': 'tr',
  };

  return langMap[langCode] || 'en';
}

/**
 * Get auth translation function
 */
export function getAuthTranslation(lang: Language) {
  const t = authTranslations[lang] || authTranslations.en;
  return (key: string): string => t[key] || authTranslations.en[key] || key;
}
