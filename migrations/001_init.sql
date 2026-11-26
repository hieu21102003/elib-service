-- elib-service Giai đoạn 1 — schema khởi tạo (PostgreSQL)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS categories_parent_name_idx
  ON categories (COALESCE(parent_id::text, ''), lower(name));
CREATE INDEX IF NOT EXISTS categories_parent_idx ON categories (parent_id);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  doc_type text,
  language text,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('public', 'internal', 'private')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  price numeric(12, 2) CHECK (price IS NULL OR price >= 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_category_idx ON documents (category_id);
CREATE INDEX IF NOT EXISTS documents_status_idx ON documents (status);
CREATE INDEX IF NOT EXISTS documents_visibility_idx ON documents (visibility);
CREATE INDEX IF NOT EXISTS documents_created_by_idx ON documents (created_by);

CREATE TABLE IF NOT EXISTS document_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  storage_path text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  file_size bigint NOT NULL CHECK (file_size > 0),
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  page_count integer CHECK (page_count IS NULL OR page_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS document_files_document_idx ON document_files (document_id);
CREATE INDEX IF NOT EXISTS document_files_checksum_idx ON document_files (checksum_sha256);

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);
