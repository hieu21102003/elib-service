-- elib-service — xem trước giới hạn trang cho tài liệu (Giai đoạn A).
-- Thêm cột preview vào document_files. page_count đã có từ 001 (job điền).
-- Dự án không dùng down-migration (migrate.ts chỉ chạy tiến, ghi _migrations);
-- file này viết idempotent để chạy lại an toàn.

ALTER TABLE document_files
  ADD COLUMN IF NOT EXISTS preview_path text,
  ADD COLUMN IF NOT EXISTS preview_pages integer,
  ADD COLUMN IF NOT EXISTS preview_status text
    CHECK (preview_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
  ADD COLUMN IF NOT EXISTS preview_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS preview_error text;

CREATE INDEX IF NOT EXISTS document_files_preview_status_idx
  ON document_files (preview_status);

-- Điền trạng thái ban đầu cho file đã có: PDF -> pending (job sẽ xử lý),
-- định dạng khác -> unsupported (giai đoạn này chưa xem trước được).
-- Chỉ chạm các dòng chưa có trạng thái để chạy lại không ghi đè kết quả job.
UPDATE document_files
SET preview_status = CASE WHEN mime_type = 'application/pdf' THEN 'pending' ELSE 'unsupported' END
WHERE preview_status IS NULL;
