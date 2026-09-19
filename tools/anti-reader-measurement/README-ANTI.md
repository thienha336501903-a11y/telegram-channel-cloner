# Anti Reader Measurement Bundle 1.0.0

Gói này đo đường tải Telegram → Windows Reader ở chế độ tách biệt, chỉ đọc.
Nó chứa runtime đóng băng Python 3.12.10 + Telethon 1.45.0; máy Anti không
cần cài Python và không cần đồng bộ repository.

## Trước khi chạy

1. Đóng hoàn toàn `YeuNauAnReader.exe` và mọi cửa sổ/worker Reader.
2. Không mở Telegram Desktop trong khi phép đo đang chạy.
3. Giải nén toàn bộ ZIP vào một thư mục mới. Không chạy trực tiếp bên trong ZIP.
4. Không nhập, gửi hoặc chụp API hash, session hay nội dung file cấu hình.

Launcher sẽ tự dừng nếu Reader/worker còn chạy, packet sai hash, cấu hình Reader
không đọc được, dung lượng trống dưới 2 GiB hoặc runtime không đúng phiên bản.

## Một lệnh duy nhất

Mở PowerShell trong thư mục vừa giải nén và chạy:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Run-AntiReaderMeasurement.ps1
```

Không chạy với quyền Administrator. Không truyền thêm tham số.

Thời gian dự kiến phụ thuộc đường truyền. Probe chỉ đọc đúng một profile,
channel và ba message đã khóa trong `measurement-targets.json`; launcher kiểm
tra hash file này trước khi chạy nên không thể tự ý đổi target.

Khi thành công, cuối màn hình sẽ hiện:

```text
MEASUREMENT_PASS
RESULT_ZIP=C:\...\ANTI_READER_RESULT_....zip
TEMP_ROOT=C:\...\AntiReaderMeasurement\...
```

Nếu thất bại:

```text
MEASUREMENT_FAIL
REASON=<lý do cụ thể>
```

Gửi lại file tại `RESULT_ZIP`. Không gửi `reader-manager.dat`.

## Cam kết an toàn

- Không gọi Reader Manager loop, claim/heartbeat/finish job hay Supabase.
- Không kết nối hoặc upload object storage.
- Không ghi cấu hình/profile/session; session chỉ được giải mã bằng DPAPI trong
  bộ nhớ của đúng Windows user rồi mở bằng `StringSession` trong bộ nhớ.
- Hash cấu hình được kiểm tra trước và sau. Khác hash sẽ `MEASUREMENT_FAIL`.
- Media tạm bị xóa ngay sau khi tính byte count và SHA-256; cả launcher và probe
  đều dọn lại thư mục media khi có lỗi.
- Telemetry/log đã lọc, không chứa API hash hoặc session.

## Control bằng Telegram Desktop sau khi probe kết thúc

Chỉ làm sau khi đã thấy `MEASUREMENT_PASS` và probe/Reader đều không chạy:

1. Xóa cache video đúng nguồn nếu có thể, rồi restart Telegram Desktop.
2. Tải từ 0% file control được ghi trong hướng dẫn bàn giao kèm packet.
3. Ghi tổng số giây.
4. Tốc độ MiB/s = `số_byte / 1048576 / số_giây`.

Gửi `RESULT_ZIP` kèm số giây control Telegram Desktop để phân tích bottleneck.
