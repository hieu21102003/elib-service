-- elib-service — tìm kiếm không dấu (unaccent) + trigram cho GET /api/documents.
-- Tạo extension cần quyền DB owner/superuser; user postgres trong docker-compose đủ quyền.
-- (unaccent + pg_trgm là extension "trusted" từ PostgreSQL 13+, DB owner cũng tạo được.)

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() gốc không IMMUTABLE nên không dùng được trong index biểu thức.
-- Wrapper này cố định từ điển 'public.unaccent' và khai IMMUTABLE — mẫu chuẩn
-- trong tài liệu PostgreSQL cho unaccent. Extension mặc định cài vào schema public;
-- nếu search_path khi migrate khác đi, cần kiểm tra lại tên từ điển này.
CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

-- Index trigram cho tìm kiếm LIKE '%...%'. Biểu thức index khớp ĐÚNG biểu thức
-- trong điều kiện tìm kiếm (f_unaccent(lower(...))) để planner dùng được index.
CREATE INDEX IF NOT EXISTS documents_title_trgm_idx
  ON documents USING gin (f_unaccent(lower(title)) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS documents_description_trgm_idx
  ON documents USING gin (f_unaccent(lower(COALESCE(description, ''))) gin_trgm_ops);
