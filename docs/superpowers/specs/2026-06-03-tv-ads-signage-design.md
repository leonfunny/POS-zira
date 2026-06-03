# TV Quảng Cáo — Google TV Signage do POS điều khiển

**Ngày:** 2026-06-03
**Trạng thái:** Design approved (chờ user review spec → writing-plans)
**Repo:** POS-zira (app Android đặt chung, thư mục `android-tv-ads/`)

## 1. Vấn đề & Mục tiêu

Quán chè (chesaigon) muốn dùng **Google TV treo tường làm màn hình quảng cáo**. Một
app Android cài trên Google TV kết nối tới app POS qua **WiFi nội bộ** và phát các
video được đưa vào "module quảng cáo" trong POS.

Yêu cầu cốt lõi (đã chốt với user):
- POS làm **server LAN**, TV **kéo** nội dung về phát (không phụ thuộc cloud/internet).
- App Android TV **native Kotlin** (APK nhẹ, sideload).
- TV **tự tìm** POS qua **mDNS** (không cần nhập IP thủ công; có fallback nhập IP/QR).
- **Playlist nhiều video.** Có 2 chế độ: phát lần lượt (sequential) hoặc lặp 1 video (repeat-one).
- Quản lý video **trong Settings của POS** (chọn file → copy vào thư mục nội bộ → phục vụ qua LAN).
- **Mọi cài đặt điều khiển từ POS.** App TV là "thin client" không có màn hình setting riêng.
  Đổi cài đặt ở POS → TV cập nhật **tức thì**.

## 2. Kiến trúc tổng thể

```
┌─────────────────────────────┐         WiFi LAN          ┌──────────────────────┐
│  POS-zira (Electron, POS1)  │                            │  Google TV (Android) │
│                             │  mDNS _zira-ads._tcp  ───▶ │  "Zira TV Ads" APK   │
│  Settings: TV Quảng cáo     │                            │                      │
│   - upload/sắp xếp video    │  GET /playlist.json   ◀─── │  - mDNS discover     │
│   - chế độ phát, mute, vol  │  GET /video/:id (Range)◀── │  - ExoPlayer Media3  │
│                             │  SSE /events (push)   ───▶ │  - loop, auto-recon  │
│  AdDisplayModule (LAN HTTP) │                            │                      │
│   userData/ad-videos/*.mp4  │                            │                      │
└─────────────────────────────┘                            └──────────────────────┘
```

3 phần độc lập, mỗi phần có biên giới rõ:
1. **POS Settings UI** — quản lý nội dung & cài đặt (renderer).
2. **AdDisplayModule** — server LAN + mDNS + SSE (main process).
3. **Android TV app** — player thuần (Kotlin).

## 3. Component ① — POS Settings: "TV Quảng cáo"

**File:** `src/renderer/components/Settings.tsx` (thêm 1 section), i18n `translations.ts`.

UI:
- Danh sách video: thêm (file picker `.mp4`), kéo sắp thứ tự, bật/tắt từng cái, xoá.
  Khi thêm: app **copy** file vào `userData/ad-videos/` (đổi tên theo id) — không giữ tham chiếu đường dẫn gốc.
- **Chế độ phát:** radio `Phát lần lượt (playlist)` / `Lặp 1 video` (+ chọn video khi lặp-1).
- Tắt/bật tiếng, thanh âm lượng.
- Hiện trạng thái server: đang chạy?, IP LAN, port, số TV đang kết nối.
- Toggle bật/tắt toàn bộ tính năng `tvAdEnabled`.

Config mới trong `AgentConfig` (`src/shared/types.ts`):
```ts
tvAdEnabled: boolean;
tvAdPort: number;                 // mặc định 17893
tvAdPlaybackMode: 'sequential' | 'repeat-one';
tvAdRepeatVideoId: string | null; // dùng khi repeat-one
tvAdMuted: boolean;               // mặc định true
tvAdVolume: number;               // 0..100
tvAdPlaylist: Array<{ id: string; filename: string; order: number; enabled: boolean }>;
```

## 4. Component ② — AdDisplayModule (main process)

**File mới:** `src/main/modules/ad-display.module.ts` theo pattern `BaseModule`
(`src/main/core/module.ts`), đăng ký trong app bootstrap như các module khác.

**Server LAN** — tái dùng style `src/main/hardware/scale/scale-network-service.ts`
(`http.createServer`, liệt kê IPv4 qua `os.networkInterfaces()`):
- `GET /health` → `{ ok: true, name, version }`
- `GET /playlist.json` → toàn bộ trạng thái app TV cần:
  ```jsonc
  {
    "version": "<hash của playlist+settings>",
    "playbackMode": "sequential",
    "repeatVideoId": null,
    "muted": true,
    "volume": 0,
    "videos": [{ "id": "v1", "url": "/video/v1", "order": 0 }]
  }
  ```
- `GET /video/:id` → stream mp4 từ `ad-videos/`, **hỗ trợ HTTP Range** (status 206,
  `Accept-Ranges: bytes`, `Content-Range`) để TV tua/buffer mượt.
- `GET /events` → **SSE**; khi config/playlist đổi, push event `playlist-changed`
  kèm `version` mới → TV gọi lại `/playlist.json`.

**mDNS:** quảng bá service `_zira-ads._tcp` (port = `tvAdPort`, TXT `name=<tên salon/POS>`)
bằng thư viện thuần JS (vd `bonjour-service` / `multicast-dns`) để không cần native build.

**Vòng đời:** start/stop theo `tvAdEnabled`; reload khi config đổi (đổi version, đẩy SSE).
**IPC:** trả status (running, ips[], port, connectedClients) cho Settings;
nhận lệnh từ renderer khi user lưu cài đặt.

## 5. Component ③ — Android TV app "Zira TV Ads"

**Vị trí:** `android-tv-ads/` trong repo POS-zira (Gradle project độc lập).

- **1 Activity** full-screen, dùng **ExoPlayer (AndroidX Media3)**.
- **Discovery:** dùng `NsdManager` resolve `_zira-ads._tcp`. Thấy → tự kết nối
  (nhớ host vào SharedPreferences cho lần sau). Không thấy trong N giây → màn hình
  pairing: nhập IP thủ công **hoặc quét QR** (QR do POS Settings hiển thị, chứa `ip:port`).
- **Phát:** tải `/playlist.json` → dựng ExoPlayer playlist.
  - `sequential`: phát hết rồi lặp lại từ đầu (REPEAT_MODE_ALL).
  - `repeat-one`: chỉ `repeatVideoId`, lặp vô hạn (REPEAT_MODE_ONE).
  - Áp `muted`/`volume` từ playlist.
- **Cập nhật tức thì:** giữ kết nối SSE `/events`; nhận `playlist-changed` →
  tải lại playlist, áp ngay (giữ vị trí nếu video không đổi). Fallback: poll
  `/playlist.json` mỗi 30s nếu SSE rớt.
- **Signage behavior:** `keepScreenOn`, ẩn system UI (immersive), tự khởi động lại
  phát khi lỗi; auto-reconnect khi mất WiFi rồi có lại.
- **Tự chạy khi bật TV:** đăng ký `BOOT_COMPLETED` receiver + là LEANBACK launcher app.
- **Phân phối:** build APK release, **sideload** lên Google TV (không qua Play Store).

## 6. Luồng dữ liệu (end-to-end)

1. NV mở Settings → "TV Quảng cáo" → thêm video → app copy vào `ad-videos/`, cập nhật `tvAdPlaylist`.
2. AdDisplayModule cập nhật version, đẩy SSE `playlist-changed`.
3. TV (đang nghe SSE) gọi `/playlist.json`, kéo video qua `/video/:id` (Range), phát theo `playbackMode`.
4. NV đổi chế độ phát / mute ở POS → bước 2–3 lặp lại → TV đổi ngay.
5. Mất internet vẫn chạy (toàn bộ qua LAN). Mất WiFi → TV tự kết nối lại khi có lại.

## 7. Quyết định mặc định

- Port `17893` (cạnh scale 17891).
- Video **muted** mặc định (`tvAdMuted=true`), có thể bật tiếng + chỉnh volume từ POS.
- Update tức thì qua **SSE**, fallback poll **30s**.
- **Không transcode** — video phải là **mp4/H.264** Google TV phát được (validate phần mở rộng + báo lỗi nếu codec lạ là tương lai, không làm bây giờ).
- mDNS bằng thư viện JS thuần (tránh native rebuild trên Windows POS1).

## 8. Phạm vi — KHÔNG làm (YAGNI)

- Không quản lý qua cloud / dashboard web.
- Không lịch chiếu theo giờ (dayparting), không nhắm nhiều salon.
- Không sync "đơn hàng / sản phẩm đang bán" lên TV — chỉ playlist quảng cáo loop.
- Không transcode video, không chỉnh sửa video trong app.
- App TV **không** có màn hình setting riêng (trừ pairing nhập IP/QR lần đầu).

## 9. Kế hoạch test

**POS (vitest):**
- Config playlist: thêm/sắp xếp/bật-tắt/xoá cập nhật `tvAdPlaylist` đúng; copy file vào `ad-videos/`.
- AdDisplayServer: `/playlist.json` đúng shape & version đổi khi config đổi; `/video/:id`
  trả **206 + Content-Range** đúng cho Range request; `/health` 200.
- SSE phát event khi version đổi.

**Android (thủ công + cơ bản):**
- Discovery mDNS tìm thấy POS; fallback nhập IP hoạt động.
- Playlist phát đúng 2 chế độ; mute/volume áp đúng.
- Đổi cài đặt ở POS → TV reload < vài giây.
- Mất/khôi phục WiFi → tự kết nối lại; reboot TV → app tự chạy.

## 10. Deploy

- POS: theo workflow hiện có — sửa trên Netcup clone `/home/paul/POS-zira-feature`
  → push (PAT) → pull Alienware typecheck/test → deploy POS1 (git pull + `npm run build`
  + restart electron qua `ZiraAIStartTemp`). Có migration config không? Không (chỉ thêm
  field config, không đổi schema DB).
- Android: build APK trên máy có Android SDK (Alienware) → sideload lên Google TV.
