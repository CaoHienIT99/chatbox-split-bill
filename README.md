## Bot Telegram chia bill (4 người) - NodeJS

### Yêu cầu

- Node.js 18+
- Token bot Telegram

### Cài đặt

```bash
npm install
cp .env.example .env
# Mở .env và điền TELEGRAM_BOT_TOKEN, tuỳ chọn GROUP_CHAT_ID
```

### Chạy bot

```bash
npm run start
# hoặc trong quá trình dev:
npm run dev
```

### Hướng dẫn sử dụng

- Mời bot vào nhóm hoặc chat riêng với bot
- Các lệnh:
  - `/start` hướng dẫn
  - `/names A,B,C,D` đặt tên 4 người; `/names` để xem tên hiện tại
  - `/spent <Tên> <Số tiền> [ghi chú]` ghi lại ai đã thanh toán
  - `/split` tính toán và hiển thị kết quả (tổng, mỗi người, cân đối, gợi ý chuyển khoản)
  - `/reset` xoá chi tiêu hiện tại
  - `/getchatid` lấy Chat ID (dùng để cấu hình `GROUP_CHAT_ID`)
  - `/announce` gửi kết quả gần nhất lên group (dùng `GROUP_CHAT_ID`, nếu không có sẽ gửi vào chat hiện tại)

### Ghi chú

- Dữ liệu được lưu trong bộ nhớ theo `chatId`. Khi bot khởi động lại, dữ liệu sẽ mất.
- Mặc định nhóm 4 người. Bạn có thể đổi tên bằng `/names`.

### Ví dụ thao tác nhanh

```text
/names An,Binh,Chi,Dung
/spent An 350000 Bia
/spent Chi 150000 Tráng miệng
/split
/announce
```
