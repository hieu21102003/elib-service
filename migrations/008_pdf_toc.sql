-- elib-service — mục lục PDF tự động & ghi đè thủ công (Phase C).
-- Gắn 1-1 theo document_files.id để giữ riêng cây mục lục cho từng phiên bản.
-- Chỉ dùng migration tiến, viết idempotent để chạy lại an toàn.

CREATE TABLE IF NOT EXISTS document_file_tocs (
  file_id            uuid PRIMARY KEY REFERENCES document_files(id) ON DELETE CASCADE,

  -- Trạng thái hàng đợi job nền
  job_status         text NOT NULL DEFAULT 'pending'
                       CHECK (job_status IN ('pending', 'processing', 'done', 'failed', 'unsupported')),
  locked_at          timestamptz,
  attempts           integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error         text,

  -- Kết quả trích xuất tự động + phiên bản thuật toán đi kèm
  auto_status        text CHECK (auto_status IN ('ok', 'partial', 'needs_ocr', 'failed', 'unsupported')),
  auto_strategy      text,          -- 'outline' | 'printed_toc' | 'outline+printed_toc' | 'body_headings' | 'none(needs_ocr)' | 'failed' | 'unsupported'
  auto_flags         text[] NOT NULL DEFAULT '{}',
  auto_payload       jsonb,
  algorithm_version  text,          -- vd 'pdf-toc-v1.0', lưu cả cột DB và trong auto_payload.algorithmVersion
  extracted_at       timestamptz,

  -- Lớp chỉnh sửa thủ công bởi quản trị viên (tách biệt, không bao giờ bị backfill ghi đè)
  manual_override    boolean NOT NULL DEFAULT false,
  manual_payload     jsonb,
  manual_updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  manual_updated_at  timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Quét nhanh job chờ / kiểm tra job treo
CREATE INDEX IF NOT EXISTS document_file_tocs_job_idx
  ON document_file_tocs (job_status, locked_at)
  WHERE job_status IN ('pending', 'processing');

-- Phục vụ backfill:toc --reextract-outdated khi nâng cấp algorithm_version
CREATE INDEX IF NOT EXISTS document_file_tocs_algo_idx
  ON document_file_tocs (algorithm_version)
  WHERE job_status = 'done';

-- Phục vụ danh sách hàng đợi rà soát trong Admin
CREATE INDEX IF NOT EXISTS document_file_tocs_review_idx
  ON document_file_tocs (auto_status, manual_override)
  WHERE auto_status IN ('partial', 'needs_ocr', 'failed');
