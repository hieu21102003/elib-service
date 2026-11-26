-- elib-service — file PDF cho tiêu chuẩn (Phase A).
-- Một tiêu chuẩn = một document; phiên bản sửa đổi = version mới của
-- document_files (bản cũ giữ nguyên). Thêm:
-- - document_files.version_label: nhãn chữ tùy chọn của phiên bản
--   (vd "Sửa đổi 1:2023") bên cạnh số version.
-- - document_files.uploaded_by / uploaded_at: người tải + thời điểm của
--   TỪNG phiên bản (created_at cũ vẫn giữ; uploaded_at backfill = created_at).
-- - document_files.code_check_*: hàng đợi job nền kiểm tra mã chuẩn có
--   xuất hiện trong vài trang đầu của PDF hay không (chỉ cảnh báo,
--   không chặn tài liệu). NULL = file không gắn tiêu chuẩn, không kiểm tra.
-- - documents.current_file_id: con trỏ phiên bản hiện hành (mặc định là
--   file mới nhất; admin có thể đặt lại về bản cũ). NULL = chưa có file
--   hoặc dữ liệu cũ chưa backfill (code tự suy ra file mới nhất).
-- Viết idempotent như 004/006 để chạy lại an toàn.

ALTER TABLE document_files
  ADD COLUMN IF NOT EXISTS version_label text,
  ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS code_check_status text
    CHECK (code_check_status IN ('pending', 'processing', 'found', 'not_found', 'failed')),
  ADD COLUMN IF NOT EXISTS code_check_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS code_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS code_check_error text;

-- File đã có từ trước: thời điểm tải = thời điểm tạo dòng.
UPDATE document_files SET uploaded_at = created_at WHERE uploaded_at IS NULL;
ALTER TABLE document_files ALTER COLUMN uploaded_at SET DEFAULT now();
ALTER TABLE document_files ALTER COLUMN uploaded_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS document_files_code_check_status_idx
  ON document_files (code_check_status);

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS current_file_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_current_file_fk'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT documents_current_file_fk
      FOREIGN KEY (current_file_id) REFERENCES document_files(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_current_file_idx
  ON documents (current_file_id);

-- Backfill con trỏ phiên bản hiện hành = file mới nhất của mỗi tài liệu.
-- Chỉ điền các dòng đang NULL nên chạy lại không ghi đè lựa chọn của admin.
UPDATE documents d
SET current_file_id = f.id
FROM (
  SELECT DISTINCT ON (document_id) id, document_id
  FROM document_files
  ORDER BY document_id, version DESC, created_at DESC
) f
WHERE f.document_id = d.id AND d.current_file_id IS NULL;
