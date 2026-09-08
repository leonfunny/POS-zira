# Android native release readiness — 2026-09-08

## Trạng thái mới nhất — N0/N1 đã hoàn thành, chưa production

**Đã có APK thử nghiệm native đúng source parity mới, chưa cài hoặc phát hành.** Đã sửa chặn quyền Internet còn sót từ Stage1, giữ nguyên HTTPS-only, backup/debug/provider/export, dev package và unsigned-release guards. 97 policy tests chạy local đạt; Netcup chạy lại 35 policy tests, 3 Stage2 tests, responsive login smoke ba kích thước, Gradle build và debug/release merged-manifest gates đều đạt. Native unit suite chỉ là 1 test cơ bản mỗi variant; không được coi là kiểm thử nghiệp vụ trên thiết bị.

- APK local đã đối chiếu SHA sau tải về: [Zira POS WIP TEST](C:/Users/maxis/enail/POS-zira-artifacts/android-parity-test-20260908T085617Z/Zira-POS-1.0.26-2026090801-WIP-TEST.apk).
- [Checksum](C:/Users/maxis/enail/POS-zira-artifacts/android-parity-test-20260908T085617Z/SHA256SUMS.txt), [artifact report](C:/Users/maxis/enail/POS-zira-artifacts/android-parity-test-20260908T085617Z/artifact-report.json).
- APK SHA-256: `2d456368e905aebec4ef6ad02a956437cb8acc819f48a0d264616f80c2d6d4ce`.
- Dev package `com.ziraai.posdiagnostics.dev`, version `1.0.26`, internal test versionCode `2026090801`, Android Debug signer. Không phải signer/identity/allocator production.
- **Production vẫn NO-GO**: build đạt không đóng các yêu cầu signing, duy trì dữ liệu qua update, thiết bị thật, đối soát/chaos, backend/live authorization, dependency risk hay các quyết định owner còn thiếu.
- Chưa login native, cài thiết bị, chạy emulator, ký release, publish hoặc restart quầy. Các bảng “chưa có APK” bên dưới là trạng thái **đầu phiên** trước N0/N1, không phải kết quả hiện tại.

## Bằng chứng lịch sử đầu phiên và phạm vi ban đầu

**Chưa được phát hành Android production.** Kiểm tra trực tiếp ngày 2026-09-08 cho kết quả `NO-GO (22 blocked)`. Đây là kết quả của bộ chặn phát hành hiện tại, không phải kết luận rằng có 22 lỗi nghiệp vụ mới.

Mục tiêu là Android POS bán độc lập, dùng chung trải nghiệm/nghiệp vụ với Windows. Đây không phải APK printer-agent/companion hay Android TV; không dùng quy trình phát hành của các ứng dụng đó thay cho POS.

Đợt đánh giá ban đầu chỉ đọc mã/cấu hình, kiểm tra toolchain, thiết bị và chạy bộ kiểm tra readiness. Sau đó đã được giao chuẩn bị JDK, sửa N0 networking và build N1 trong snapshot riêng (nhật ký bên dưới). Chỉ chuyển source sang Netcup phát triển và tải APK test về; không publish artifact ứng dụng, cài APK, xóa dữ liệu, khởi động emulator hoặc restart máy bán hàng. `adb devices` có tự khởi động daemon ADB trên máy phát triển; không kết nối/cài vào thiết bị nào.

## Bằng chứng đầu phiên trước chuẩn bị N1

| Hạng mục | Windows phát triển | Netcup phát triển |
| --- | --- | --- |
| POS checkout đã kiểm tra | `C:/Users/maxis/enail/POS-zira-release-foundation`, HEAD `af33318a149e0c0234ae31c4f7e5304cd4f5c0fc`, có thay đổi chưa commit | `/var/www/pos-zira`, `main`, HEAD ngắn `165a753` |
| Node / npm đang chọn | `24.13.0` / `11.6.2` — sai pin | `22.22.2` / `10.8.2` — đúng pin |
| Java đang chọn | `1.8.0_503` — sai pin | `21.0.12.1` — khác pin chính xác `21.0.11` |
| SDK | `C:/Users/maxis/AppData/Local/Android/Sdk`, platform 36, build-tools 36.0.0 có sẵn; biến SDK chưa đặt | `/home/paul/Android/Sdk`, platform 36 và build-tools 36.0.0 có sẵn |
| ADB đang kết nối | Không có thiết bị | Không có thiết bị |
| AVD có cấu hình | `zira_pos_b1_api36`, chưa khởi động | `rf_pixel_36`, chưa khởi động; không sử dụng AVD của dự án khác |
| APK/AAB trong `android-pos/app/build/outputs` | Không tìm thấy trong phạm vi đã kiểm tra | Không tìm thấy trong phạm vi đã kiểm tra |

Runtime Node kèm Codex được kiểm tra là `24.19.0`, cũng không đúng pin. Không tìm thấy JDK 21.0.11 trong các vị trí runtime phổ biến đã kiểm tra; chưa quét toàn bộ máy và không khẳng định máy tuyệt đối không có phiên bản đó.

**Cập nhật N1:** đã tải và xác minh JDK Temurin 21.0.11+10 trong cache task riêng trên Netcup; default Java hệ thống trong bảng vẫn giữ nguyên 21.0.12.1. Dùng đường dẫn cụ thể trong nhật ký chuẩn bị ở cuối tài liệu cho job build tiếp theo.

Không được build thẳng canonical Netcup `main` rồi gọi đó là bản sửa mới: HEAD khác checkout Windows và các thay đổi parity chưa có provenance artifact. Cần snapshot đúng toàn bộ thay đổi được nghiệm thu, không chỉ ghi SHA cũ rồi bỏ qua dirty diff/untracked source.

## Những chặn phát hành xác minh được từ cấu hình

1. `applicationId` và namespace vẫn là `com.ziraai.posdiagnostics.dev`; Capacitor đặt tên `Zira POS Diagnostics Dev`.
2. Chưa có release signing config hoặc Play flavor. Script build-only yêu cầu `app-release-unsigned.apk`, từ chối `app-release.apk` đã ký. Không bỏ guard để đạt build xanh.
3. `versionName` lấy từ `package.json` (`1.0.26`); `versionCode` lấy property/env build number, mặc định `1`. Chưa có production allocator được phê duyệt; không dùng mặc định `1` cho nâng cấp thực tế.
4. Merged debug/release manifests chưa có artifact ở checkout Windows hiện tại, vì vậy chưa có bằng chứng native build của phiên bản sửa.
5. `package.json` vẫn khai báo Node 20.x trong khi pipeline Android pin Node 22.22.2; cần baseline Windows trên Node 22 và quyết định contract, không sửa engines để che lỗi.
6. Bộ gate phát hiện legacy tag publication và local upload scripts ngoài lane build-only. Không tạo tag `v*`, không chạy script upload hoặc chỉnh `latest.yml` trong đợt kiểm tra này.
7. R12 (APK Android TV trong installer Windows) **đã PASS** và có phê duyệt ngày 2026-07-29. Các tài liệu tháng 7 nói R12 vẫn blocked không còn mô tả đúng checkout này.

Register còn chặn các bằng chứng backend, kill-switch, token storage, durable writes, hardware, dependency advisories, CI và billiard. Những dòng này là yêu cầu/bằng chứng phê duyệt chưa được đóng; không tự động chứng minh code hiện tại chưa triển khai. Nhóm backend/client phải đối chiếu implementation và production artifact rồi gắn evidence thật. Không đánh dấu approved hàng loạt từ yêu cầu chung “lên production”. Số advisory trong ghi chú register là lịch sử, chưa chạy audit mới trong đánh giá này.

## Plan N1 — tạo APK test đúng nguồn

Owner: người tổng hợp release; chỉ bắt đầu sau khi các agent ngừng sửa source và bộ test parity đạt.

1. Chốt danh sách diff + untracked source của POS; kiểm tra không có secret hoặc dữ liệu khách. Tạo immutable snapshot có manifest/hash hoặc reviewed commit. Ghi SHA nền và hash diff nếu vẫn dùng snapshot dirty.
2. Chọn Netcup làm build host vì Node/npm và SDK đã phù hợp. Dùng POS worktree/snapshot riêng **ngoài cây enail**, không chỉnh canonical `/var/www/pos-zira` đang được người khác sử dụng.
3. Cung cấp JDK **21.0.11** riêng cho job và đặt `JAVA_HOME`, `PATH`, `ANDROID_SDK_ROOT` trong tiến trình build; không đổi Java toàn hệ thống, không nới pin lên 21.0.12.1. Nếu phải tải runtime, kiểm tra nguồn/checksum theo quy trình dependency được phê duyệt.
4. Chạy `npm run android:preflight`; mọi pin phải PASS trước khi nhận artifact. Dùng lockfile của chính snapshot; không cập nhật dependency ngẫu nhiên.
5. Chạy tests nghiệp vụ parity đã chốt, `npm run typecheck:renderer`, các boundary/policy tests rồi `npm run android:build:verify` và `npm run test:android:manifests`. Runner sẽ kiểm tra source → bundle → native assets, native unit tests, debug APK, AndroidTest APK và unsigned release artifacts.
6. Ghi report từng lệnh, phiên bản runtime, nguồn snapshot, SHA-256 từng APK/AAB, versionName/versionCode, applicationId và certificate fingerprint của **APK test**. Không ghi keystore, mật khẩu hoặc token.
7. Artifact dùng cài test là `app-debug.apk`. Unsigned release APK/AAB chỉ là build evidence, không phát hành hoặc gọi là APK production. Debug certificate không phải production signer và không được đổi tên file để giả thành production.

Tiêu chí N1: có APK test truy vết được đúng source đã sửa và toàn bộ build/manifest/security checks đạt. N1 không tự chứng minh hoạt động tốt trên máy POS thật.

## Plan N2 — native và nâng cấp giữ dữ liệu

Owner: QA native; dùng test salon và thiết bị chuyên test, chưa mở bán thật.

1. Dùng AVD POS riêng hoặc Android test đã xác nhận model, phiên bản Android, WebView và độ phân giải. Không dùng AVD Netcup thuộc dự án khác chỉ vì sẵn có.
2. Trước khi cài, đọc package/version/signing fingerprint đang cài. Nếu đã có dữ liệu, không uninstall/clear-data và không dùng cờ downgrade để vượt lỗi cài.
3. Chạy instrumentation trên đúng một thiết bị test được chọn. Script instrumentation hiện không có guard thiết bị cụ thể như reinstall probe, nên môi trường phải được cô lập; không để nó tự chạy lên POS đang bán.
4. Kiểm thử toàn màn hình, xoay màn hình, system Back, keyboard, mạng chập chờn, kill/relaunch. So Windows từng luồng: login/salon isolation, mở/đóng ca, món/topping/course/ghi chú, bàn/covers, lưu/mở check, thanh toán/tiền thừa, in/gửi bếp/pickup, lịch sử/đối soát.
5. Chứng minh độc lập: tắt phiên Windows, Android vẫn tạo/sửa/hoàn tất đơn bằng ca/check của chính thiết bị; không nhận nhầm occupancy/check của register khác. Đồng bộ lại không tạo đơn hoặc vé bếp trùng.
6. Tạo dữ liệu test ở bản cũ: thiết bị ID, ca mở, check chưa thanh toán, order chưa sync, catalog cache. Thực hiện **update in-place** với package và signer phù hợp, versionCode hợp lệ; kiểm tra toàn bộ dữ liệu và số tiền trước/sau, cả crash giữa migration/flush và mất mạng khi update.
7. `test:android:reinstall` là probe **cố ý uninstall rồi cài lại**, xác nhận synthetic sentinels không được restore. Nó chỉ nhận emulator và không phải test update-preserves-data; tuyệt đối không dùng trên máy có đơn/ca thật.
8. Chưa có quy trình export/recovery production được xác minh trong phạm vi này. Manifest tắt backup; không dựa vào Android/Google backup như cách cứu đơn cục bộ. Nếu không có bảo toàn dữ liệu được chứng minh, dừng nâng cấp máy đó.

Tiêu chí N2: nhật ký và ảnh/video trên thiết bị chỉ rõ model/OS/WebView, nguồn APK, PASS/FAIL từng luồng; update giữ dữ liệu cục bộ được xác nhận riêng, không đánh đồng với fresh install.

## Plan N3 — production identity, signing và rollout

Owner: chủ sản phẩm + release owner; thực hiện sau N1/N2 và các hợp đồng backend production đã nghiệm thu.

- Xác nhận app đang cài trên Android đích có package ID nào; chọn giữ identity hiện có hay tạo sản phẩm production mới. ID mới không tự nhìn thấy DB sandbox của ID dev; nếu đổi ID phải có migration/export-import được thiết kế và kiểm thử, không uninstall app cũ để “sửa login”.
- Chọn kênh phân phối chính thức (managed/private Play hoặc enterprise sideload), chủ quản signing key và certificate fingerprint. Không tự tạo/đổi khóa production khi chưa có quyết định về continuity; upload key và app-signing key không được lẫn nhau.
- Xác nhận highest versionCode hiện có và allocator tăng đơn điệu. Không lấy số run CI đơn lẻ làm toàn bộ hợp đồng update production.
- Sửa Gradle/flavor, policy và decision register **cùng một packet đã review**. Bộ build-only hiện chủ động cấm production identity/signing; thêm production lane rõ ràng, không tháo guard của lane development.
- Tách Android update channel khỏi Windows `latest.yml` và các APK printer/TV. Chỉ publish immutable artifact đã ký và hash xác minh; kiểm tra hậu phát hành tải về đúng bytes.
- Thí điểm một máy/salon sau khi ca an toàn, không có payment outcome chưa rõ và đã đối soát hàng chờ. Backend cho phép đúng thiết bị, có cách dừng nhận đơn mới phía server. Không restart Windows tại quầy để cập nhật Android.
- Nếu lỗi, dừng cấp bản mới/nhận đơn mới, giữ nguyên DB và bản đã cài; rollback bằng một bản sửa tương thích và versionCode mới sau test. Không tự hạ app rồi xóa DB khi schema đã tiến lên.

Thông tin cần chủ sản phẩm cung cấp trước N2/N3: model máy Android POS, thiết bị in/cân/scanner/terminal thanh toán, package đang cài, kênh phân phối mong muốn, nơi quản lý signer hiện có và thời điểm quầy ngừng nhận đơn. Chỉ cần fingerprint/chủ quản khóa, không gửi secret vào chat.

## Phương pháp và giới hạn bằng chứng

- Tier 2, graph `C-Users-maxis-enail-POS-zira-release-foundation`, generation `2026-09-08T08:26:32Z`.
- Coverage checked cho build runners, toolchain verifier, readiness gate, Gradle, package.json, workflow, register, manifest và Capacitor config. `scripts/`/`docs/` excluded; Gradle partial ở dòng 6/13/44 và các file còn lại metadata changed. Đã đọc trực tiếp toàn bộ các source cấu hình/script được dùng cho kết luận trọng yếu.
- Toolchain/readiness/ADB/AVD là kết quả lệnh ngày 2026-09-08, không dựa vào báo cáo tháng 7. Các docs lịch sử chỉ dùng làm ngữ cảnh; register được đọc trực tiếp.
- Không kiểm tra trạng thái signer/key ngoài repo, Play Console, máy Android thật hoặc APK production đang cài vì chưa có đích được xác định; không suy luận signer production không tồn tại chỉ từ Gradle dev.
- Kết quả build native mới được ghi ở đầu tài liệu và nhật ký cuối; không ghi nhận deploy/test vật lý thành công. Parent rollout plan: `android-windows-production-rollout-2026-09-08.md`.

## Nhật ký N1 — JDK đúng pin đã sẵn sàng

Ngày 2026-09-08, sau chỉ đạo chuẩn bị runtime riêng:

- Host/user xác minh: Netcup `v2202602332329430916`, `paul`, Linux `x86_64`.
- Vendor: Eclipse Adoptium / Eclipse Temurin, OpenJDK `21.0.11+10-LTS`, HotSpot Linux x64 JDK.
- Release chính thức: [jdk-21.0.11+10](https://github.com/adoptium/temurin21-binaries/releases/tag/jdk-21.0.11%2B10).
- Release API đã đọc: `https://api.github.com/repos/adoptium/temurin21-binaries/releases/tags/jdk-21.0.11%2B10`.
- Binary: `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_x64_linux_hotspot_21.0.11_10.tar.gz`.
- Published checksum: `https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/OpenJDK21U-jdk_x64_linux_hotspot_21.0.11_10.tar.gz.sha256.txt`.
- SHA-256 binary: `4b2220e232a97997b436ca6ab15cbf70171ecff52958a46159dfa5a8c44ca4de`. Khớp cả checksum file vendor và digest asset trả về từ GitHub API; `sha256sum --check` PASS **trước** giải nén/chạy binary.
- Cache owner `paul:paul`, mode `700`: `/home/paul/.cache/zira-pos-android-release-20260908`.
- JDK sử dụng: `/home/paul/.cache/zira-pos-android-release-20260908/jdk-21.0.11+10`.
- Archive và checksum được giữ nguyên trong cache để kiểm tra lại. Kiểm tra tên entry archive không có absolute path hoặc `..` traversal; giải nén không lấy owner từ archive.
- `bin/java -version`: `openjdk version "21.0.11"`, `Temurin-21.0.11+10`, `21.0.11+10-LTS`.
- `bin/javac -version`: `javac 21.0.11`.
- `java -version` mặc định sau chuẩn bị vẫn `21.0.12.1`; Node/npm vẫn `22.22.2`/`10.8.2`. Không đổi alternatives, shell profile, system packages hoặc service.

Job build tiếp theo phải đặt `JAVA_HOME` bằng đường dẫn JDK trên, thêm `$JAVA_HOME/bin` vào đầu `PATH` của **job**, và đặt `ANDROID_SDK_ROOT=/home/paul/Android/Sdk`. Chỉ chạy preflight/build trong immutable POS snapshot do parent chuẩn bị; chưa chạy preflight của snapshot hoặc Gradle trong bước này, vì các agent client còn sửa source.

Nguồn API Adoptium truy vấn version ban đầu trả 404; đã chuyển sang GitHub release chính thức của cùng vendor, không dùng mirror hay thay version để vượt pin. Chuẩn bị JDK chỉ đóng chặn môi trường của N1; không thay đổi verdict production hoặc tạo APK mới.

### Snapshot đầu tiên — tạm dừng trước build để sửa native networking

Source/test đã chốt lúc `2026-09-08T08:50:46Z`; snapshot bao gồm 2.212 file / 27.216.901 byte từ HEAD `af33318a149e0c0234ae31c4f7e5304cd4f5c0fc` cộng working-tree bytes. Có đủ ba file mới `src/shared/restaurant-order-upload.ts`, `tests/restaurant-order-upload.test.ts`, `tests/android-restaurant-order-upload.test.ts` và test schema v7 đã sửa.

- Archive local: `C:/Users/maxis/AppData/Local/Temp/zira-pos-native-snapshot-20260908T085046Z.tar.gz`.
- Archive remote: `/var/www/pos-zira-wt/android-parity-test-20260908T085046Z/source-snapshot.tar.gz`.
- Archive SHA-256 đối chiếu sau transfer: `24d6b65c86432733325607ff2ef62dd026182642bcc7ca30252544d6d8e50ae6`.
- Source tree hash: `21043fc6b8bd0e4025673027f4a2a54e66795a0637827194ec196d85df9c786c`.
- Manifest cạnh thư mục source lưu SHA-256, size, git mode, tracked/untracked từng file và allowlist. Helper từ chối unsafe path, symlink/junction, signing secrets và dữ liệu DB/log; byte source được đối chiếu lại sau copy để bắt thay đổi trong lúc snapshot.
- Allowlist: `src/`, `tests/`, `android-pos/` source/resources; Android policy docs/workflow; root package/lock/TS/Vite/Vitest/Tailwind/PostCSS/Capacitor configs; đúng 9 build/policy scripts liên quan. Không đưa node_modules, .git, env, generated build/dist/native web assets, DB/logs, standalone TV apps hay driver resources vào archive.

Trước extraction/npm/build, phát hiện manifest thiếu `android.permission.INTERNET`; merged-manifest verifier và Stage1 policy test còn chủ động cấm permission này. Browser smoke với CSP HTTPS không kiểm tra được quyền mạng của native APK, nên build xanh lúc này vẫn không chứng minh đăng nhập thật hoạt động.

Parent đã yêu cầu tạm dừng build, đang sửa đồng bộ permission + policy tests theo yêu cầu POS độc lập. Giữ HTTPS-only, no cleartext, dev identity và unsigned-release guards. Snapshot đầu tiên chỉ là bằng chứng WIP cũ, **không dùng làm candidate sau khi native networking thay đổi**; phải chụp lại source và hash mới trước build.

### N0 đã sửa và được kiểm thử

Các file phạm vi N0: `android-pos/app/src/main/AndroidManifest.xml`, `scripts/verify-android-manifests.mjs`, `tests/android-stage1-policy.test.ts`, test mới `tests/android-merged-manifest-policy.test.ts`, ghi chú supersession trong tài liệu Stage1. Không sửa signing/package/network-security settings.

Thêm đúng `android.permission.INTERNET`. Verifier bắt buộc đúng một declaration không giới hạn SDK; vẫn từ chối permission lạ, permission SDK-tag ngoài allowlist, cleartext, backup, debug, FileProvider/provider lạ, exported non-launcher, protection level không signature. Xuất hàm policy thực tế để test positive/negative dùng cùng logic với CLI; import hàm không chạy Gradle. Thêm kiểm tra dev package và giữ kiểm tra product/build version. 18 fixture tests mới bao gồm thiếu quyền, quyền trong comment, trùng quyền, SDK cap, unknown/paired/SDK-tag permissions và các bảo vệ hiện hữu.

Đối chiếu parent: OPTIONS tới `https://api.enail.pro/api/v1/b2b/pos/capabilities` với Origin `https://localhost` trả 204, ACAO cùng origin, method POST và authorization được cho phép. Đây chỉ là bằng chứng CORS preflight do parent kiểm tra, không phải native login hoặc backend business acceptance.

### N1 build hoàn tất từ snapshot mới

- Snapshot thời điểm `2026-09-08T08:56:17Z`: 2.213 file / 27.223.169 byte; cùng allowlist và kiểm tra an toàn nêu trên, có đủ N0 fix/test mới.
- Local archive: `C:/Users/maxis/AppData/Local/Temp/zira-pos-native-snapshot-20260908T085617Z.tar.gz`.
- Build sandbox: `/var/www/pos-zira-wt/android-parity-test-20260908T085617Z/source` (ngoài enail).
- Archive SHA-256: `1581ad80ed4545f77b1e23ddac7c8d9abee5dc86a4dec7a083a6cdc5c8db6ce7`; khớp sau transfer trước giải nén.
- Source tree SHA-256: `6b88d7898b58ad2c5230853f7928d2738ccef1141e43a52b96ada7559befaead`. 2.213 input file hash đều giữ nguyên sau build; không có sửa source trong build copy. `gradlew` phục hồi executable bit từ git mode `100755`, không sửa nội dung.
- Lockfile `npm ci` đạt; toàn bộ toolchain preflight đúng pin. Dùng Chromium đã có sẵn trong cache; không cần tải browser hay đổi dependency.
- Boundary gates: 149 source files; 5 bundle files; 7 native copied assets files được scanner kiểm tra. Kiểm chứng SHA độc lập toàn bộ **27 web payload files** giữa `dist/android-web` → native assets → bytes bên trong APK đạt.
- Gradle `:app:test`, debug app, debug AndroidTest, unsigned release APK và release AAB đạt: 271 tasks thực thi, build 57 giây. Merged debug/release manifest task + policy đạt; copied native security policy đạt.
- Log từng bước, manifest per-file và `artifact-report.json` ở thư mục `evidence/` cạnh `source/`; nội dung source manifest cạnh archive. APK test local và report đã tải về thư mục artifacts riêng, ngoài repo source.

| Artifact | Byte | SHA-256 |
| --- | ---: | --- |
| `app-debug.apk` | 10.926.077 | `2d456368e905aebec4ef6ad02a956437cb8acc819f48a0d264616f80c2d6d4ce` |
| `app-debug-androidTest.apk` | 1.129.449 | `88c46064901219622a17a04f617a3dae76fdb50a87d366dbfa6fd70486d6593f` |
| `app-release-unsigned.apk` | 10.891.433 | `73a6b35983b7a155104e8f9b7ae3a15f067d8351b9c9d4ba0054afdad28ab1ca` |
| `app-release.aab` (unsigned) | 4.775.658 | `19f9a6d7b94f5fbcadde8844ca3a3a9fa254cc3ec98697d3e44480923ac9a9ff` |

Android Debug signer SHA-256: `507de850280c17aba0631860e0919e08a3a19de9581cd103aa7184421a058727`. APK package inspection xác nhận INTERNET, dev package, versionName `1.0.26`, versionCode `2026090801`, target SDK36. Release APK bị `apksigner verify` từ chối đúng kỳ vọng unsigned (exit1); AAB không có signature entries. Các task có tên `signReleaseBundle` không được dùng để suy luận đã ký: kiểm tra bytes artifact xác nhận unsigned.

### Dependency audit tại build và phần còn thiếu

`npm ci` báo **50 advisory entries cho toàn lockfile**: 3 low, 11 moderate, 31 high, 5 critical. `npm audit --omit=dev --json` (report lưu `evidence/npm-audit-runtime.json`) báo **17 production-dependency entries**: 10 moderate, 7 high, 0 critical. Hai package được audit đánh dấu direct là `@nut-tree-fork/nut-js` và `electron-updater`; transitive bao gồm `engine.io-client`, `socket.io-parser`, `ws`, `builder-util-runtime`, `form-data`, `js-yaml` và các dependency khác trong JSON.

Đây không phải “50 lỗi Android có thể khai thác”: dependency tree chung Windows/Android rộng hơn code đóng trong APK; chưa đánh giá exploit reachability từng advisory. Không chạy audit fix, không thay lockfile hoặc tự miễn trừ dependency gate. Vẫn cần packet phân tích/remediation phù hợp trước production.

N1 chỉ chứng minh artifact đúng source, toolchain và policy hiện tại. N2 native/device/hardware/update-preserves-data và N3 production identity/signing/rollout chưa thực hiện. Không suy từ Chromium smoke sang native payment/printing đúng, hay từ hai unit tests cơ bản sang chaos/reconciliation đạt.
