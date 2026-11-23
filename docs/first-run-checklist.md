# elib Giai đoạn 1 — Checklist chạy lần đầu trên máy công ty (~15 phút)

Mục đích: đóng điểm **chưa kiểm chứng** của Giai đoạn 1 — toàn bộ luồng DB thật
(migrate → seed → tạo admin → đăng nhập → upload → tải file) chưa từng chạy với
PostgreSQL sống. Làm xong checklist này mới coi như Giai đoạn 1 chạy được thật.
Đánh dấu từng bước; bước nào lỗi thì dừng và ghi lại nguyên văn lỗi.

## 0. Chuẩn bị

- [ ] Node ≥ 22 (`node --version`) hoặc Docker + Compose (`docker compose version`)
- [ ] PostgreSQL đang chạy (nếu chạy Node trực tiếp): tạo DB + user riêng cho elib
- [ ] Thư mục lưu file trên ổ 1.5TB đã tạo, user chạy service ghi được vào đó
      (ví dụ `/data/elib-storage` khi chạy Node trực tiếp; Docker Compose mặc định
      dùng volume `elib_storage` — nếu đổi sang bind-mount thư mục thật thì chạy
      `sudo chown -R 1000:1000 /data/elib-storage`)
- [ ] File `.env` đã điền: `DATABASE_URL`, `STORAGE_ROOT` (đường dẫn tuyệt đối),
      `SESSION_SECRET` (chuỗi ngẫu nhiên dài, KHÔNG để mặc định),
      `COOKIE_SECURE=false` (HTTP trong LAN), `MAX_UPLOAD_MB=200`

## 1. Khởi tạo dữ liệu (chạy 1 lần)

Node trực tiếp:
```bash
npm install
npm run migrate            # kỳ vọng: "applied 001_init.sql" rồi "Migration hoàn tất."
npm run seed:categories    # kỳ vọng: tạo 6 nhóm mẫu CAT01–CAT06
npm run create-admin -- --email admin@congty.vn --password 'MatKhauManh' --name 'Quản trị'
```

Docker Compose (sau `docker compose up -d --build`):
```bash
docker compose exec elib npm run migrate
docker compose exec elib npm run seed:categories
docker compose exec elib npm run create-admin -- --email admin@congty.vn --password 'MatKhauManh' --name 'Quản trị'
```

- [ ] Chạy lại `migrate` lần 2 → kỳ vọng "skip 001_init.sql (đã chạy)" (idempotent)

## 2. Khởi động + health

```bash
npm run build && npm start          # hoặc: docker compose up -d
docker compose exec elib wget -qO- http://127.0.0.1:3200/health   # kỳ vọng: {"status":"ok",...}
```

- [ ] `/health` trả 200
- [ ] Mở `http://<máy>:3200/` thấy trang upload tạm + form đăng nhập

## 3. Smoke test luồng chính (dùng đúng 1 file PDF thật nhỏ)

- [ ] Đăng nhập bằng admin vừa tạo → vào được trang upload
- [ ] Upload 1 file PDF + điền metadata (tiêu đề, danh mục, tag) → thành công,
      thấy thanh tiến trình chạy
- [ ] Kiểm tra trên đĩa: file nằm ở `{STORAGE_ROOT}/originals/{doc_id}/v1/{file_id}.pdf`
- [ ] Upload **lại đúng file đó** → kỳ vọng lỗi `409 DUPLICATE_FILE`, giao diện
      cho chọn "Bỏ qua" hoặc "Vẫn tạo mới" (force)
- [ ] Tải file qua endpoint download → file tải về đúng tên gốc (`original_filename`)
- [ ] Đăng xuất → thử tải lại file `internal`/`private` khi chưa đăng nhập → bị chặn

## 4. Smoke test kiểm tra file (3 ca nhanh)

- [ ] Đổi đuôi 1 file `.txt` thành `.pdf` rồi upload → bị từ chối (magic bytes không khớp)
- [ ] Upload file `.dwg` thật (nếu có) → được chấp nhận
- [ ] Upload file > 200 MB (nếu có sẵn) → bị từ chối với lỗi tiếng Việt rõ ràng

## 5. Kiểm tra qua Reverse_proxy + nginx (tích hợp đã merge PR #4, master 0dc4577)

- [ ] `curl http://127.0.0.1:3100/api/elib/auth/me` → 401 JSON tiếng Việt (chưa đăng nhập)
- [ ] Mở Smart.Rail qua domain/nginx, vào mục **Tài liệu**, đăng nhập admin,
      upload lại 1 file PDF > 1 MB → thành công (nếu lỗi 413: nginx chưa có
      `client_max_body_size 220m` cho `/api/elib/` — xem bản sửa đã chuẩn bị ở
      `~/workspace/reverse-proxy-nginx-fix/`, file trong repo Reverse_proxy
      `deploy/nginx/reverse-proxy.conf` hiện chưa có dòng này)
- [ ] Upload 1 file lớn gần 200 MB (nếu có) qua domain → không bị cắt ở 60s
      (nginx `proxy_read_timeout`/`proxy_send_timeout` cho `/api/elib/` phải ≥ 300s,
      khớp `ELIB_TIMEOUT_MS=300000`)
- [ ] Tải file vừa upload qua giao diện Tài liệu → đúng tên gốc
- [ ] Tài khoản viewer đăng nhập → không thấy form upload
- [ ] Tìm kiếm tiêu chuẩn vẫn chạy, và VSQI có kết quả thật trên mạng server
      (không nằm trong `partialFailures`) — phép thử VSQI live còn thiếu từ trước

## 6. Sau khi pass

- [ ] Ghi lại: phiên bản Node/PostgreSQL, `STORAGE_ROOT` thật, cổng đang dùng
- [ ] Đặt lịch sao lưu: dump PostgreSQL + thư mục `STORAGE_ROOT` (file gốc là tài sản thật)
- [ ] Báo lại kết quả để quyết định bước tiếp: tạo repo GitHub cho elib
      (code hiện chỉ ở `~/workspace/elib-service/`, chưa có git/repo — server
      chưa `git clone` được), hoặc Giai đoạn 2

> elib không publish cổng ra host (chỉ nghe trong mạng Docker `elib-net`), người dùng vào qua Reverse_proxy/nginx.
> Đừng mở cổng 3200 ra Internet.
