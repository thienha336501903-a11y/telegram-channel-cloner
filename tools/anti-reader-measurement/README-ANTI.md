# Anti Reader Measurement Bundle 2.0.0

Gói này đo đường tải Telegram → Windows Reader ở chế độ tách biệt, chỉ đọc.
Nó chứa runtime đóng băng Python 3.12.10 + Telethon 1.45.0; máy Anti không
cần cài Python và không cần đồng bộ repository.

V2 tách hoàn toàn metadata của launcher khỏi thư mục output do probe sở hữu.
Probe chỉ chạy khi output chưa tồn tại và tự tạo thư mục đó, nên lỗi
`output_directory_must_be_new_and_empty` của V1 không thể tái diễn theo cùng cách.

## Trước khi chạy

1. Đóng hoàn toàn `YeuNauAnReader.exe` và mọi cửa sổ/worker Reader.
2. Đóng Telegram Desktop và không tải file khác trong khi probe chạy.
3. Giải nén toàn bộ ZIP vào một thư mục mới. Không chạy trực tiếp bên trong ZIP.
4. Không nhập, gửi hoặc chụp API hash, session hay file `reader-manager.dat`.
5. Nên cắm sạc và giữ nguyên chế độ nguồn/mạng trong suốt phép đo.

Launcher sẽ tự dừng nếu còn Reader/probe khác, packet sai hash, manifest không
đúng safety contract, target không khớp manifest, cấu hình Reader không đọc được,
dung lượng trống dưới 2 GiB hoặc runtime không đúng phiên bản.

## Một lệnh duy nhất

Mở PowerShell trong thư mục vừa giải nén và chạy:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-AntiReaderMeasurement.ps1
```

Không chạy với quyền Administrator. Không truyền thêm tham số.

Probe chỉ đọc đúng một profile, một channel và ba message đã khóa trong packet;
launcher kiểm tra checksum và đối chiếu chéo target/manifest trước khi chạy.

Khi thành công, cuối màn hình sẽ hiện:

```text
MEASUREMENT_PASS
RESULT_ZIP=C:\...\ANTI_READER_RESULT_....zip
TEMP_ROOT=C:\...\AntiReaderMeasurement\...
```

Nếu thất bại, launcher vẫn cố đóng gói bằng chứng an toàn:

```text
MEASUREMENT_FAIL
REASON=<lý do cụ thể>
RESULT_ZIP=C:\...\ANTI_READER_RESULT_FAILED_....zip
```

Gửi lại file tại `RESULT_ZIP`. Không gửi `reader-manager.dat`.

## Dữ liệu chẩn đoán

V2 ghi backend crypto thực tế, thời gian AES, CPU process/core, CPU hệ thống,
RSS, DC, latency p50/p95 từng GetFile, bytes/request, retry/FloodWait/reset/
migration, max in-flight, exact raw bytes và SHA-256. Việc tính SHA-256 diễn ra
sau cửa sổ đo download để không làm chậm throughput được đo.

Retry hoặc migration được giữ lại như cảnh báo chất lượng thay vì làm mất toàn
bộ kết quả; sai byte, sai chunk, song song ngoài ý muốn, download error hoặc media
không dọn được vẫn là lỗi cứng.

## Cam kết an toàn

- Không gọi Reader Manager loop, claim/heartbeat/finish job hay Supabase.
- Không kết nối hoặc upload object storage.
- Không ghi cấu hình/profile/session; session chỉ được giải mã bằng DPAPI trong
  bộ nhớ của đúng Windows user rồi mở bằng `StringSession` trong bộ nhớ.
- Hash cấu hình được kiểm tra trước và sau; khác hash sẽ `MEASUREMENT_FAIL`.
- Media tạm bị xóa sau khi xác thực byte/SHA; launcher dọn lại khi có lỗi.
- Result packager chỉ nhận danh sách telemetry cho phép và loại file lạ hoặc file
  có dấu hiệu chứa credential.

## Control bằng Telegram Desktop sau khi probe kết thúc

Chỉ làm sau `MEASUREMENT_PASS`, khi probe và Reader đều đã tắt:

1. Bảo đảm file control chưa có trong cache; restart Telegram Desktop.
2. Tải file control từ 0% trên cùng máy và cùng mạng.
3. Dùng đồng hồ bấm giờ từ lúc bấm tải đến lúc hoàn tất; ghi tổng số giây.
4. Tốc độ MiB/s = `số_byte / 1048576 / số_giây`.

Gửi `RESULT_ZIP` kèm số giây control Telegram Desktop để phân tích bottleneck.
