# elib-service — Giai đoạn 1 (Upload tài liệu)

Backend riêng cho thư viện tài liệu số (elib) của công ty đường sắt.
**Giai đoạn 1 chỉ gồm:** đăng nhập tối thiểu, upload 1 file + metadata, lưu file trên ổ đĩa máy công ty, ghi PostgreSQL, tải file qua endpoint có kiểm tra quyền, trang upload tạm.
Chưa làm: upload nhiều file (Giai đoạn 2), tác vụ nền (Giai đoạn 3), trang quản lý tài liệu (Giai đoạn 4), tích hợp giao diện Smart.Rail (làm sau khi Giai đoạn 1 được duyệt — xem mục cuối).

## Công nghệ

- Fastify 5 + TypeScript (Node ≥ 22), `@fastify/multipart` (upload stream), `@fastify/cookie`
- PostgreSQL qua `pg` + migration SQL thuần (`migrations/`), không dùng ORM nặng
- `file-type` + kiểm tra magic bytes tự viết (OLE/ZIP/TXT-UTF8/DWG), SHA-256 dạng stream
- Mật khẩu: argon2id (`@node-rs/argon2`); session phía server (bảng `sessions`, DB chỉ lưu SHA-256 của token), cookie `httpOnly`, `SameSite=Lax`, `Secure` cấu hình qua `COOKIE_SECURE`
- Test: vitest

## Chạy trên máy Linux của công ty

Yêu cầu: Node ≥ 22, PostgreSQL đang chạy, một thư mục trên ổ đĩa cho file (ví dụ `/data/elib-storage`).

```bash
npm install
cp .env.example .env   # điền DATABASE_URL, STORAGE_ROOT, SESSION_SECRET...
npm run migrate        # tạo bảng
npm run seed:categories  # danh mục MẪU (sẽ thay bằng danh sách thật sau)
npm run create-admin -- --email admin@congty.vn --password 'MatKhauManh' --name 'Quản trị'
npm run build && npm start   # hoặc: npm run dev
```

Mở `http://<máy>:3200/` để dùng trang upload tạm. Kiểm tra sức khỏe: `GET /health`.

Biến môi trường chính (xem `.env.example`): `DATABASE_URL`, `STORAGE_ROOT`, `MAX_UPLOAD_MB` (mặc định 200), `PORT` (mặc định 3200), `SESSION_SECRET`, `COOKIE_SECURE` (đặt `false` khi chạy HTTP trong LAN, `true` khi có HTTPS), `SESSION_TTL_DAYS`.

## Deploy trên server (Docker)

Cách chạy khuyến nghị trên server: Docker Compose gồm 2 service — `postgres` (PostgreSQL 16, không mở cổng ra host) và `elib` (build từ `Dockerfile`, chỉ nghe `127.0.0.1:3200` trên host). File tài liệu nằm trong volume `elib_storage`, dữ liệu DB trong volume `pgdata`.

```bash
# 1. Lấy code về server (clone repo khi đã có, hoặc copy thư mục elib-service)
cd elib-service

# 2. Tạo .env và ĐỔI các giá trị mặc định: POSTGRES_PASSWORD, SESSION_SECRET
cp .env.example .env
#    (mật khẩu DB nên dùng ký tự an toàn cho URL: chữ/số)

# 3. Build + khởi động
#    (mạng elib-net phải tồn tại trước: Reverse_proxy compose tạo khi up,
#     hoặc tạo tay: docker network create elib-net)
docker compose up -d --build

# 4. Khởi tạo dữ liệu (chạy 1 lần; migrate/seed chạy lại vẫn an toàn)
docker compose exec elib npm run migrate
docker compose exec elib npm run seed:categories
docker compose exec elib npm run create-admin -- --email admin@congty.vn --password 'MatKhauManh' --name 'Quản trị'

# 5. Kiểm tra
curl http://127.0.0.1:3200/health
```

Sau đó nối Reverse_proxy vào elib (phần tích hợp `/api/elib/*` đã có sẵn trong Reverse_proxy):

- Reverse_proxy chạy **Docker** (khuyến nghị): hai bên dùng chung Docker network tên cố định `elib-net` — Reverse_proxy compose khai báo mạng này (tự tạo khi `docker compose up`, hoặc tạo tay `docker network create elib-net`), compose của elib ở trên tham gia bằng external network cùng tên (chỉ service `elib`). Đặt phía Reverse_proxy: `ELIB_BASE_URL=http://elib-service:3200` (tên container của elib). Kiểm tra: `docker exec reverse-proxy wget -qO- http://elib-service:3200/health`.
  - **Lưu ý mạng Docker:** cách cũ `host.docker.internal:3200` không dùng được — `host.docker.internal` trỏ tới IP cổng cầu nối (bridge gateway, ví dụ `172.17.0.1`), không phải `127.0.0.1` của host, mà cổng elib chỉ bind `127.0.0.1:3200` nên container khác gọi qua bridge sẽ bị từ chối. Mạng dùng chung `elib-net` tránh được chuyện này và giữ elib không lộ ra LAN.
- Reverse_proxy chạy **Node trực tiếp** trên cùng máy: `ELIB_BASE_URL=http://127.0.0.1:3200`.
- Đặt `TRUST_PROXY=true` khi đứng sau Caddy/nginx, rồi khởi động lại Reverse_proxy.
- Mở Smart.Rail, vào mục **Tài liệu**, đăng nhập bằng admin vừa tạo, upload thử 1 file và tải xuống để kiểm tra end-to-end.

Lưu ý vận hành:

- Cổng 3200 của elib **chỉ** mở ở localhost trên host; đừng mở thẳng ra Internet — người dùng luôn vào qua Reverse_proxy.
- Sao lưu định kỳ cả 2 volume: `pgdata` (database) và `elib_storage` (file gốc — đây là tài sản thật). Ví dụ dump DB: `docker compose exec postgres pg_dump -U elib elib > backup.sql`.
- Muốn file nằm thẳng trên ổ đĩa lớn của máy thay vì Docker volume: sửa `docker-compose.yml`, thay volume `elib_storage` bằng bind-mount (ví dụ `/data/elib-storage:/data/storage`) và `sudo chown -R 1000:1000 /data/elib-storage`. Tương tự, volume `pgdata` cũng có thể đổi thành bind-mount (ví dụ `/srv/elib/pgdata:/var/lib/postgresql/data`) nếu muốn DB nằm trên phân vùng dữ liệu riêng thay vì ổ hệ thống.
- Checklist kiểm tra lần chạy đầu (migrate → đăng nhập → upload → tải file, gồm cả qua Reverse_proxy): xem `docs/first-run-checklist.md`.

## Lưu trữ file

- Đường dẫn: `{STORAGE_ROOT}/originals/{doc_id}/v{version}/{file_id}.{ext}` — Giai đoạn 1 luôn `version = 1`, ID là UUID. DB chỉ lưu đường dẫn **tương đối**; mọi đường dẫn đều dựng bằng `path.join`.
- Mọi truy cập file đều qua storage service (`src/storage/`: `save` / `open` / `delete`) để sau này đổi sang S3/MinIO chỉ sửa một chỗ.
- Upload ghi vào `{STORAGE_ROOT}/tmp` trước (cùng filesystem), kiểm tra xong mới `rename` vào chỗ chính thức, rồi mới ghi DB trong transaction. Lỗi ở bất kỳ bước nào đều xóa file tạm/file vừa chuyển — không để file mồ côi, không để bản ghi mồ côi.
- Thư mục storage **không** được serve tĩnh. File gốc chỉ tải được qua endpoint download sau khi kiểm tra quyền.

## Kiểm tra file (server)

- Định dạng thật theo nội dung (magic bytes), không tin đuôi file. Whitelist: PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, JPG/PNG/WEBP, TXT, DWG.
- `.doc/.xls/.ppt` đời cũ dùng chung magic OLE (`D0 CF 11 E0`) → phân biệt bằng đuôi file; magic OLE với đuôi khác bị từ chối.
- `.docx/.xlsx/.pptx` là ZIP (`PK`) → magic + đuôi phải khớp; nếu quét được entry trong ZIP thì phải đúng họ (`word/`/`xl/`/`ppt/`).
- `.txt` không có magic → kiểm tra toàn file là UTF-8 hợp lệ (strict), không chứa byte NUL.
- `.dwg` bắt đầu bằng chuỗi phiên bản `AC10xx` (ví dụ `AC1015`, `AC1027`, `AC1032`).
- Dung lượng tối đa cấu hình bằng `MAX_UPLOAD_MB` (mặc định 200 MB), tính SHA-256 dạng stream. Tên file bị chặn nếu chứa `../`, dấu phân cách thư mục hoặc ký tự nguy hiểm; tên gốc (đã làm sạch) lưu ở `original_filename` để hiển thị khi tải.
- Trùng SHA-256 với file đã có → API trả `409 DUPLICATE_FILE` kèm thông tin tài liệu cũ; người dùng chọn bỏ qua hoặc gửi lại với `force=true` để vẫn tạo mới.

## API (Giai đoạn 1)

| Method | Đường dẫn | Quyền | Mô tả |
| --- | --- | --- | --- |
| GET | `/health` | công khai | Kiểm tra dịch vụ |
| POST | `/api/auth/login` | công khai | Đăng nhập (JSON `{email, password}`), đặt cookie session httpOnly |
| POST | `/api/auth/logout` | đã đăng nhập | Đăng xuất, xóa session |
| GET | `/api/auth/me` | đã đăng nhập | Thông tin người dùng hiện tại |
| GET | `/api/categories` | công khai | Cây danh mục cho dropdown |
| POST | `/api/documents` | admin/editor | Upload 1 file (multipart) + metadata: `title*`, `description`, `category_id`, `tags` (cách nhau bằng dấu phẩy, tự tạo nếu chưa có), `doc_type`, `language`, `visibility`, `status`, `force` |
| GET | `/api/documents/:id/files/:fileId/download` | theo ma trận dưới | Tải file qua storage service, tên tải = `original_filename` |

Lỗi trả dạng `{ "error": { "code": "...", "message": "<tiếng Việt>" } }`.

### Ma trận quyền tải file

| Trạng thái / Hiển thị | Chưa đăng nhập | viewer | editor | admin | Người tạo |
| --- | --- | --- | --- | --- | --- |
| published + public | ✔ | ✔ | ✔ | ✔ | ✔ |
| published + internal | ✘ | ✔ | ✔ | ✔ | ✔ |
| published + private | ✘ | ✘ | ✘* | ✔ | ✔ |
| draft / hidden (mọi visibility) | ✘ | ✘ | ✔ | ✔ | ✔ |

\* Editor không phải người tạo không tải được tài liệu `private` đã xuất bản (theo đúng quy tắc "người tạo hoặc admin").

Upload: chỉ `admin`/`editor`. `viewer` gọi API upload nhận `403`; trang upload tạm ẩn form với viewer.

## Dữ liệu

Bảng: `users` (role admin/editor/viewer), `sessions`, `categories` (cây `parent_id`), `documents` (có `price` nullable — chưa hiện trên form Giai đoạn 1, chưa thanh toán), `document_files` (`page_count` để trống — Giai đoạn 3 mới đếm), `tags`, `document_tags`. Migration ở `migrations/001_init.sql`, chạy bằng `npm run migrate` (có bảng `_migrations`, chạy lại an toàn).

Danh mục seed hiện là **dữ liệu mẫu** (6 nhóm Smart.Rail CAT01–CAT06 + danh mục con của nhóm Hạ tầng) — sẽ thay bằng danh sách thật khi được cung cấp.

## Test

```bash
npm run typecheck
npm test
```

Test unit cho storage service và kiểm tra file chạy không cần PostgreSQL. Test tích hợp DB (`tests/api.integration.test.ts`) bị bỏ qua (skip) trừ khi đặt `ELIB_RUN_DB_TESTS=1` kèm `DATABASE_URL` trỏ tới PostgreSQL thật đã migrate — xem ghi chú trong file test.

## Tích hợp Reverse_proxy (đã làm)

Phần tích hợp vào giao diện Smart.Rail đã hoàn thành ở phía Reverse_proxy (PR #4, đã merge): Reverse_proxy có proxy `/api/elib/*` → elib (stream upload/download, chuyển tiếp cookie session) và mục **Tài liệu** trong Smart.Rail (đăng nhập, upload, tải file vừa tải lên). Phía elib không cần sửa gì thêm — chỉ cần elib đang chạy và Reverse_proxy trỏ đúng `ELIB_BASE_URL` (xem mục "Deploy trên server (Docker)" ở trên). Reverse_proxy không giữ DB/file: toàn bộ dữ liệu, file và kiểm tra quyền nằm ở elib-service. Trang upload tạm ở `/` của elib vẫn dùng được để kiểm tra độc lập khi cần.
