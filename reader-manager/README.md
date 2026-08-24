# Yêu Nấu Ăn Reader Manager

Ứng dụng Windows dành cho người quản trị cơ bản để kết nối nhiều tài khoản
Telegram Reader với LMS V4 mà không cần cài Python, Git hoặc chạy lệnh.

## Luồng sử dụng

1. Trong Commerce Admin, mở **Quản lý Reader** và tạo mã ghép máy.
2. Cài và mở `YeuNauAnReaderSetup.exe` trên máy Windows.
3. Sao chép toàn bộ mã kết nối một lần từ V4 Admin và dán vào ứng dụng. Mã tự
   chọn đúng Cloner Preview hoặc Production; người dùng không phải nhập URL.
4. Bấm **Thêm tài khoản Telegram**, nhập số điện thoại, OTP và mật khẩu 2FA
   (nếu có) ngay trên máy.
5. Chờ trạng thái **Sẵn sàng**, sau đó chọn **Tự động** hoặc một Reader cụ thể
   khi tạo khóa V4.

OTP, mật khẩu 2FA và Telegram StringSession không được gửi tới Commerce hoặc
Cloner. Toàn bộ cấu hình cục bộ được mã hóa bằng Windows DPAPI cho đúng tài
khoản Windows đang dùng. Thu hồi Reader trong Admin khiến Agent xóa phiên tương
ứng khỏi cấu hình mã hóa ở lần đồng bộ kế tiếp.

## Build

Workflow `Reader Manager Windows` tạo installer trên Windows và tải lên dưới
dạng artifact `YeuNauAnReaderSetup`. Build cục bộ dành cho maintainer:

```powershell
./reader-manager/build.ps1
```

Không đưa API hash, token ghép máy, agent token hoặc Telegram session vào source,
artifact, log hay biến môi trường của Commerce.

Ứng dụng chỉ chấp nhận máy chủ Production chính thức hoặc Preview thuộc đúng
Vercel team của hệ thống. Mã mang URL lạ, HTTP, thông tin đăng nhập, đường dẫn,
query hoặc fragment sẽ bị từ chối trước khi ứng dụng gửi request.
