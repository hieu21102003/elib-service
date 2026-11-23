-- elib-service — DB metadata tiêu chuẩn (Bước 1, Phase 2).
-- Bảng standards/standard_sources/standard_relations/search_log nuôi dần từ
-- các lần tra cứu thật (KHÔNG crawl hàng loạt).
--
-- Khóa gộp (quyết định 2026-11-23 "Đổi hướng khóa gộp"): normalized_code =
-- chuẩn hóa NHẸ trên `code` upstream (src/standards/light-normalize.ts),
-- KHÔNG qua parser đầy đủ. Parser chỉ điền cột tùy chọn org/number/part/
-- amendment theo best-effort (NULL khi parse lỗi/confidence thấp).
-- Migration này CHƯA được áp dụng ở bất kỳ DB nào (PR-A chưa merge) nên
-- được sửa tại chỗ thay vì tạo 004.
--
-- Quan hệ thay thế chỉ lưu MỘT chiều (B replaces A), chiều ngược suy ra khi
-- hiển thị. Mã đích không năm: không tạo stub, lưu to_norm + to_base_key.
-- documents.standard_id: tài liệu gắn với tiêu chuẩn không được có giá bán
-- (CHECK std_docs_not_for_sale).
-- f_unaccent() và extension unaccent/pg_trgm đã có từ 002_search.sql.

CREATE TABLE IF NOT EXISTS standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org text,                                     -- org_normalized (best-effort từ parser)
  number text,                                  -- std_main_number (best-effort từ parser)
  part text,                                    -- chuỗi phần ("1", "1-10"...)
  year smallint,                                -- từ code ":YYYY" hoặc trường year upstream
  amendment text,
  suffix text,
  normalized_code text NOT NULL UNIQUE,         -- chuẩn hóa nhẹ, vd TCVN9386-1:2012
  base_key text NOT NULL,                       -- normalized_code bỏ đoạn ":năm"
  code_display text NOT NULL,                   -- mã như nguồn hiển thị
  title_vi text,
  title_en text,
  status text NOT NULL DEFAULT 'Unknown'
    CHECK (status IN ('Active', 'Withdrawn', 'Unknown')),
  issued_date text,                             -- 'YYYY' | 'YYYY-MM' | 'YYYY-MM-DD'
  effective_date text,
  ics text[],
  detail_level text NOT NULL DEFAULT 'summary'
    CHECK (detail_level IN ('stub', 'summary', 'full', 'manual')),
  parse_confidence numeric,                     -- confidence_score của parser (best-effort)
  is_amendment boolean NOT NULL DEFAULT false,  -- regex /AMD /COR /AC +A\d trên khóa
  needs_review boolean NOT NULL DEFAULT false,  -- năm code lệch trường year, hoặc amendment thiếu ":năm"
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS standards_base_key_idx
  ON standards (base_key text_pattern_ops);
CREATE INDEX IF NOT EXISTS standards_normalized_prefix_idx
  ON standards (normalized_code text_pattern_ops);
CREATE INDEX IF NOT EXISTS standards_title_vi_trgm_idx
  ON standards USING gin (f_unaccent(lower(title_vi)) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS standards_title_en_trgm_idx
  ON standards USING gin (f_unaccent(lower(title_en)) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS standard_sources (
  standard_id uuid NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('VSQI', 'TCVN_VN', 'TCVN_QT')),
  detail_url text,                              -- chỉ để refresh nội bộ
  payload jsonb,                                -- attributes + relations đã map; KHÔNG lưu `raw`
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (standard_id, source)
);

CREATE TABLE IF NOT EXISTS standard_relations (
  id bigserial PRIMARY KEY,
  from_id uuid NOT NULL REFERENCES standards(id) ON DELETE CASCADE,
  type text NOT NULL,                           -- replaces | equivalent | normativeReference | history | ...
  to_id uuid REFERENCES standards(id) ON DELETE SET NULL,  -- null nếu chưa resolve / đích không năm chưa có bản ghi
  to_code_raw text NOT NULL,
  to_norm text NOT NULL,                        -- normalized_code (chuẩn hóa nhẹ), hoặc UPPER(raw) nếu không chuẩn hóa được
  to_base_key text,                             -- base_key của đích — hiển thị nối theo base_key khi to_id null
  source text,
  UNIQUE (from_id, type, to_norm)
);
CREATE INDEX IF NOT EXISTS standard_relations_to_idx
  ON standard_relations (to_id);
CREATE INDEX IF NOT EXISTS standard_relations_to_base_key_idx
  ON standard_relations (to_base_key text_pattern_ops);

CREATE TABLE IF NOT EXISTS search_log (
  id bigserial PRIMARY KEY,
  query_norm text NOT NULL,
  org_guess text,
  had_result boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
  -- KHÔNG lưu user_id/IP
);

-- Liên kết tài liệu elib với tiêu chuẩn. Cột mới toàn NULL nên không dòng
-- hiện có nào có thể vi phạm CHECK; vẫn kiểm tra trước và dừng nếu vi phạm
-- (không tự sửa dữ liệu).
ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS standard_id uuid REFERENCES standards(id);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM documents
    WHERE standard_id IS NOT NULL AND price IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'documents: có dòng gắn standard_id mà vẫn có price — dừng migration 003, cần xử lý thủ công';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'std_docs_not_for_sale'
  ) THEN
    ALTER TABLE documents
      ADD CONSTRAINT std_docs_not_for_sale
      CHECK (standard_id IS NULL OR price IS NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_standard_idx
  ON documents (standard_id);
