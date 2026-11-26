-- elib-service Giai đoạn A3 bổ sung — thêm mức visibility 'members'.
-- Mức 'members': mọi tài khoản đã đăng nhập và status='active' (gồm cả external)
-- đều thấy tài liệu trong danh sách và xem được bản xem trước giới hạn trang;
-- xem toàn bộ (/view) và tải bản gốc (/download) vẫn chỉ chủ tài liệu + admin.
--
-- Trước khi chạy trên server, rà danh sách tài liệu hiện có:
--   SELECT id, title, visibility, status, created_at FROM documents ORDER BY created_at DESC;
--
-- Viết idempotent: tìm và gỡ CHECK constraint cũ liên quan tới cột visibility
-- rồi tạo lại constraint mới gồm ('public', 'members', 'internal', 'private').

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'documents'
      AND n.nspname = current_schema()
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%visibility%'
  LOOP
    EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE documents
  ADD CONSTRAINT documents_visibility_check
  CHECK (visibility IN ('public', 'members', 'internal', 'private'));
