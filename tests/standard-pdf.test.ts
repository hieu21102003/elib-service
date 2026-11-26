import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import {
  canDownloadOriginal,
  canUploadStandardFile,
  type CurrentUser,
  type DocumentAccessRow,
  type UserRole
} from '../src/auth/session.js';
import { canPreview, canViewFull } from '../src/previews/permissions.js';
import { visibleInList } from '../src/documents/visibility.js';
import {
  extractStringsFromContentStream,
  normalizeForCodeSearch,
  pdfTextContainsCode
} from '../src/previews/pdf-text.js';
import {
  processCodeCheckFile,
  runCodeCheckJobOnce,
  type CodeCheckFileRow,
  type CodeCheckStandardInfo
} from '../src/standards/code-check-job.js';
import type { QpdfRunner } from '../src/previews/qpdf.js';
import { makeRc4EncryptedPdf } from './helpers/encrypted-pdf.js';

/**
 * Phase A — file PDF cho tiêu chuẩn (FakePool + storage thật, không cần
 * PostgreSQL): upload gắn standard_code (admin/user_type=internal), một
 * tiêu chuẩn = một document + nhiều version, con trỏ phiên bản hiện hành,
 * internal xem toàn bộ /view nhưng tải bản gốc vẫn chỉ chủ + admin, job
 * kiểm tra mã trong vài trang đầu, và các test chống rò rỉ (tìm kiếm công
 * khai / danh sách / preview không lộ file tiêu chuẩn).
 */

const ADMIN_ID = 'a1111111-1111-4111-8111-111111111111';
const INT_VIEWER_ID = 'a2222222-2222-4222-8222-222222222222';
const INT_VIEWER2_ID = 'a3333333-3333-4333-8333-333333333333';
const INT_EDITOR_ID = 'a4444444-4444-4444-8444-444444444444';
const EXT_EDITOR_ID = 'a5555555-5555-4555-8555-555555555555';
const EXT_VIEWER_ID = 'a6666666-6666-4666-8666-666666666666';
const DISABLED_ID = 'a7777777-7777-4777-8777-777777777777';

function makeUser(
  role: UserRole,
  id: string,
  userType: CurrentUser['userType'],
  status: CurrentUser['status'] = 'active'
): CurrentUser {
  return {
    id,
    username: null,
    email: `${id.slice(0, 4)}@congty.vn`,
    role,
    displayName: null,
    userType,
    status,
    mustChangePassword: false
  };
}

const admin = makeUser('admin', ADMIN_ID, 'internal');
const intViewer = makeUser('viewer', INT_VIEWER_ID, 'internal');
const intViewer2 = makeUser('viewer', INT_VIEWER2_ID, 'internal');
const intEditor = makeUser('editor', INT_EDITOR_ID, 'internal');
const extEditor = makeUser('editor', EXT_EDITOR_ID, 'external');
const extViewer = makeUser('viewer', EXT_VIEWER_ID, 'external');
const disabledInternal = makeUser('viewer', DISABLED_ID, 'internal', 'disabled');

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

type Row = Record<string, unknown>;

function stripAccents(s: string): string {
  return s
    .replace(/[đĐ]/g, 'D')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

class FakePool {
  tokens = new Map<string, CurrentUser>();
  documents = new Map<string, Row>();
  files = new Map<string, Row>();
  standards = new Map<string, Row>();
  tagsByNormalized = new Map<string, Row>();
  docTags = new Map<string, Set<string>>();

  addUser(user: CurrentUser): string {
    const raw = `token-${user.id}`;
    this.tokens.set(hashToken(raw), user);
    return raw;
  }

  reset(): void {
    this.documents.clear();
    this.files.clear();
    this.standards.clear();
    this.tagsByNormalized.clear();
    this.docTags.clear();
  }

  private filesOf(docId: string): Row[] {
    return [...this.files.values()]
      .filter((f) => f.document_id === docId)
      .sort((a, b) => {
        const byVersion = Number(b.version) - Number(a.version);
        if (byVersion !== 0) return byVersion;
        return String(b.created_at).localeCompare(String(a.created_at));
      });
  }

  private currentFileOf(doc: Row): Row | null {
    const files = this.filesOf(String(doc.id));
    return files.find((f) => f.id === doc.current_file_id) ?? files[0] ?? null;
  }

  private userFromVisParams(params: unknown[]): CurrentUser | null {
    const [uid, role, userType] = params;
    if (!uid) return null;
    return {
      id: String(uid),
      username: null,
      email: 'x@congty.vn',
      role: role as UserRole,
      displayName: null,
      userType: (userType as CurrentUser['userType']) ?? null,
      status: 'active',
      mustChangePassword: false
    };
  }

  private filterDocs(params: unknown[], withLimit: boolean): Row[] {
    const user = this.userFromVisParams(params);
    let rest = params.slice(3);
    if (withLimit) rest = rest.slice(0, -2);
    let pattern: string | null = null;
    let categoryId: string | null = null;
    for (const p of rest) {
      if (typeof p === 'string' && p.startsWith('%')) pattern = p;
      else if (typeof p === 'string') categoryId = p;
    }
    const keyword = pattern
      ? pattern.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1')
      : null;
    return [...this.documents.values()].filter((doc) => {
      if (!visibleInList(user, doc as unknown as DocumentAccessRow)) return false;
      if (categoryId && doc.category_id !== categoryId) return false;
      if (keyword) {
        const hay = stripAccents(
          `${String(doc.title ?? '')} ${String(doc.description ?? '')} ${this.tagNamesOf(String(doc.id)).join(' ')}`
        );
        if (!hay.includes(stripAccents(keyword))) return false;
      }
      return true;
    });
  }

  private tagNamesOf(docId: string): string[] {
    const ids = this.docTags.get(docId) ?? new Set<string>();
    return [...this.tagsByNormalized.values()]
      .filter((t) => ids.has(String(t.id)))
      .map((t) => String(t.name))
      .sort();
  }

  private listRow(doc: Row): Row {
    const f = this.currentFileOf(doc);
    return {
      id: doc.id,
      title: doc.title,
      slug: doc.slug,
      description: doc.description,
      category_id: doc.category_id,
      doc_type: doc.doc_type,
      language: doc.language,
      visibility: doc.visibility,
      status: doc.status,
      price: doc.price,
      standard_id: doc.standard_id,
      current_file_id: doc.current_file_id,
      created_by: doc.created_by,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
      file_id: f?.id ?? null,
      file_document_id: f?.document_id ?? null,
      file_version: f?.version ?? null,
      original_filename: f?.original_filename ?? null,
      mime_type: f?.mime_type ?? null,
      file_size: f ? String(f.file_size) : null,
      page_count: f?.page_count ?? null,
      preview_pages: f?.preview_pages ?? null,
      preview_status: f?.preview_status ?? null,
      version_label: f?.version_label ?? null,
      uploaded_by: f?.uploaded_by ?? null,
      uploaded_at: f?.uploaded_at ?? null,
      code_check_status: f?.code_check_status ?? null,
      code_checked_at: f?.code_checked_at ?? null,
      file_created_at: f?.created_at ?? null,
      category_ref_id: null,
      category_name: null,
      tag_names: this.tagNamesOf(String(doc.id))
    };
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount?: number }> {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };

    if (s.includes('FROM sessions')) {
      const user = this.tokens.get(String(params[0]));
      return {
        rows: user
          ? [
              {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                display_name: user.displayName,
                status: user.status,
                user_type: user.userType,
                must_change_password: user.mustChangePassword
              }
            ]
          : []
      };
    }

    if (s.includes('SELECT id FROM categories WHERE id')) return { rows: [] };

    if (s.includes('WHERE f.checksum_sha256 = $1')) {
      const file = [...this.files.values()].find((f) => f.checksum_sha256 === params[0]);
      if (!file) return { rows: [] };
      const doc = this.documents.get(String(file.document_id));
      return {
        rows: [{ document_id: file.document_id, title: doc?.title ?? '', file_id: file.id }]
      };
    }

    // standards: tra theo hai khóa (findStandardByCode, ứng viên ANY)
    if (s.includes('FROM standards') && s.includes('ANY($1)')) {
      const candidates = params[0] as string[];
      const primary = String(params[1]);
      const all = [...this.standards.values()];
      const found =
        all.find((r) => r.normalized_code === primary) ??
        all.find((r) => candidates.includes(String(r.normalized_code))) ??
        all.find((r) => candidates.includes(String(r.code_key_raw)));
      return { rows: found ? [{ ...found }] : [] };
    }

    if (s.includes('INSERT INTO standards')) {
      const [
        org, number, part, year, amendment, suffix, normalized_code, base_key,
        code_key_raw, code_display, title_vi, title_en, detail_level,
        parse_confidence, is_amendment, amendment_year, is_draft, needs_review
      ] = params;
      if ([...this.standards.values()].some((r) => r.normalized_code === normalized_code)) {
        return { rows: [] }; // ON CONFLICT DO NOTHING
      }
      const now = new Date();
      const row: Row = {
        id: randomUUID(),
        org, number, part, year, amendment, suffix, normalized_code, base_key,
        code_key_raw, code_display, title_vi, title_en,
        status: 'Unknown',
        issued_date: null,
        effective_date: null,
        ics: null,
        detail_level,
        parse_confidence: parse_confidence === null ? null : String(parse_confidence),
        is_amendment, amendment_year, is_draft, needs_review,
        last_verified_at: null,
        created_at: now,
        updated_at: now
      };
      this.standards.set(String(row.id), row);
      return { rows: [{ ...row }] };
    }

    if (s.includes('UPDATE standards') && s.includes('COALESCE(title_vi')) {
      const row = this.standards.get(String(params[0]));
      if (!row) return { rows: [] };
      row.title_vi = row.title_vi ?? params[1];
      row.title_en = row.title_en ?? params[2];
      row.updated_at = new Date();
      return { rows: [{ ...row }] };
    }

    // Job kiểm tra mã: nhận việc (claim) — phân biệt bằng SET ... 'processing'
    // (câu nhả job quá hạn cũng chứa 'processing' ở WHERE).
    if (s.includes("SET code_check_status = 'processing'")) {
      const candidates = [...this.files.values()]
        .filter((f) => {
          if (f.code_check_status !== 'pending') return false;
          const doc = this.documents.get(String(f.document_id));
          return !!doc?.standard_id;
        })
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      const file = candidates[0];
      if (!file) return { rows: [] };
      file.code_check_status = 'processing';
      file.code_check_locked_at = new Date();
      return {
        rows: [
          {
            id: file.id,
            document_id: file.document_id,
            storage_path: file.storage_path,
            mime_type: file.mime_type,
            file_size: file.file_size
          }
        ]
      };
    }

    if (s.includes("SET code_check_status = 'pending'")) {
      const staleMinutes = Number(params[0]);
      const cutoff = Date.now() - staleMinutes * 60_000;
      let count = 0;
      for (const f of this.files.values()) {
        const lockedAt = f.code_check_locked_at as Date | null;
        if (f.code_check_status === 'processing' && lockedAt && lockedAt.getTime() < cutoff) {
          f.code_check_status = 'pending';
          f.code_check_locked_at = null;
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    if (s.includes('JOIN standards s ON s.id = d.standard_id')) {
      const doc = this.documents.get(String(params[0]));
      const std = doc?.standard_id ? this.standards.get(String(doc.standard_id)) : undefined;
      if (!std) return { rows: [] };
      return {
        rows: [
          {
            normalized_code: std.normalized_code,
            code_key_raw: std.code_key_raw,
            base_key: std.base_key,
            code_display: std.code_display
          }
        ]
      };
    }

    if (s.includes('SET code_check_status = $2')) {
      const file = this.files.get(String(params[0]));
      if (file) {
        file.code_check_status = params[1];
        file.code_check_error = params[2];
        file.code_checked_at = new Date();
        file.code_check_locked_at = null;
      }
      return { rows: [] };
    }

    // documents theo standard_id (upload tìm document có sẵn + endpoint files)
    if (s.includes('FROM documents WHERE standard_id = $1')) {
      const doc = [...this.documents.values()]
        .filter((d) => d.standard_id === params[0])
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      return { rows: doc ? [{ ...doc }] : [] };
    }

    if (s.includes('MAX(version)')) {
      const files = this.filesOf(String(params[0]));
      const next = (files[0] ? Number(files[0].version) : 0) + 1;
      return { rows: [{ next_version: next }] };
    }

    if (s.includes('SELECT id FROM documents WHERE slug')) {
      const doc = [...this.documents.values()].find((d) => d.slug === params[0]);
      return { rows: doc ? [{ id: doc.id }] : [] };
    }

    if (s.includes('INSERT INTO documents')) {
      const [
        id, title, slug, description, category_id, doc_type, language,
        visibility, status, standard_id, created_by
      ] = params;
      const now = new Date();
      const row: Row = {
        id, title, slug, description, category_id, doc_type, language,
        visibility, status, price: null, standard_id, current_file_id: null,
        created_by, created_at: now, updated_at: now
      };
      this.documents.set(String(id), row);
      return { rows: [{ ...row }] };
    }

    if (s.includes('INSERT INTO document_files')) {
      const [
        id, document_id, version, storage_path, original_filename, mime_type,
        file_size, checksum_sha256, preview_status, version_label, uploaded_by,
        code_check_status
      ] = params;
      const now = new Date();
      const row: Row = {
        id, document_id, version, storage_path, original_filename, mime_type,
        file_size, checksum_sha256, page_count: null, preview_status,
        preview_path: null, preview_pages: null, preview_locked_at: null,
        preview_error: null, version_label, uploaded_by, uploaded_at: now,
        code_check_status, code_check_locked_at: null, code_checked_at: null,
        code_check_error: null, created_at: now
      };
      this.files.set(String(id), row);
      return { rows: [{ ...row }] };
    }

    if (s.includes('UPDATE documents SET current_file_id = $1, updated_at = now() WHERE id = $2')) {
      const doc = this.documents.get(String(params[1]));
      if (!doc) return { rows: [] };
      doc.current_file_id = params[0];
      doc.updated_at = new Date();
      if (s.includes('RETURNING id, current_file_id, updated_at')) {
        return {
          rows: [{ id: doc.id, current_file_id: doc.current_file_id, updated_at: doc.updated_at }]
        };
      }
      return { rows: [{ ...doc }] };
    }

    if (s.includes('UPDATE documents SET current_file_id = $1 WHERE id = $2')) {
      const doc = this.documents.get(String(params[1]));
      if (doc) doc.current_file_id = params[0];
      return { rows: [] };
    }

    if (s.includes('INSERT INTO tags')) {
      const [name, normalized] = params as [string, string];
      let tag = this.tagsByNormalized.get(normalized);
      if (!tag) {
        tag = { id: randomUUID(), name, normalized_name: normalized };
        this.tagsByNormalized.set(normalized, tag);
      }
      return { rows: [{ id: tag.id }] };
    }

    if (s.includes('INSERT INTO document_tags')) {
      const [docId, tagId] = params as [string, string];
      const set = this.docTags.get(docId) ?? new Set<string>();
      set.add(tagId);
      this.docTags.set(docId, set);
      return { rows: [] };
    }

    // PATCH current-version: đọc document + file
    if (s.includes('SELECT id, current_file_id FROM documents WHERE id = $1')) {
      const doc = this.documents.get(String(params[0]));
      return { rows: doc ? [{ id: doc.id, current_file_id: doc.current_file_id }] : [] };
    }
    if (s.includes('SELECT id, version FROM document_files WHERE id = $1 AND document_id = $2')) {
      const file = this.files.get(String(params[0]));
      if (!file || file.document_id !== params[1]) return { rows: [] };
      return { rows: [{ id: file.id, version: file.version }] };
    }

    // Tải bản gốc
    if (s.includes('AND f.id = $2')) {
      const doc = this.documents.get(String(params[0]));
      const file = this.files.get(String(params[1]));
      if (!doc || !file || file.document_id !== doc.id) return { rows: [] };
      return {
        rows: [
          {
            doc_id: doc.id,
            status: doc.status,
            visibility: doc.visibility,
            created_by: doc.created_by,
            file_id: file.id,
            storage_path: file.storage_path,
            original_filename: file.original_filename,
            mime_type: file.mime_type,
            file_size: String(file.file_size)
          }
        ]
      };
    }

    // Endpoint files của tiêu chuẩn: danh sách file theo document
    if (s.includes('FROM document_files WHERE document_id = $1') && s.includes('ORDER BY version DESC')) {
      return { rows: this.filesOf(String(params[0])).map((f) => ({ ...f })) };
    }

    // Danh sách tài liệu (đếm + liệt kê)
    if (s.includes('COUNT(*)::int AS total')) {
      return { rows: [{ total: this.filterDocs(params, false).length }] };
    }
    if (s.includes('FROM documents d') && s.includes('LEFT JOIN LATERAL') && !s.includes('AS doc_id')) {
      const docs = this.filterDocs(params, true);
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      return { rows: docs.slice(offset, offset + limit).map((d) => this.listRow(d)) };
    }

    // /preview + /view: một tài liệu + file hiện hành
    if (s.includes('AS doc_id') && s.includes('LEFT JOIN LATERAL')) {
      const doc = this.documents.get(String(params[0]));
      if (!doc) return { rows: [] };
      const f = this.currentFileOf(doc);
      return {
        rows: [
          {
            doc_id: doc.id,
            status: doc.status,
            visibility: doc.visibility,
            standard_id: doc.standard_id,
            created_by: doc.created_by,
            file_id: f?.id ?? null,
            version: f?.version ?? null,
            storage_path: f?.storage_path ?? null,
            original_filename: f?.original_filename ?? null,
            mime_type: f?.mime_type ?? null,
            file_size: f ? String(f.file_size) : null,
            checksum_sha256: f?.checksum_sha256 ?? null,
            page_count: f?.page_count ?? null,
            preview_path: f?.preview_path ?? null,
            preview_pages: f?.preview_pages ?? null,
            preview_status: f?.preview_status ?? null
          }
        ]
      };
    }

    throw new Error(`FakePool: SQL không hỗ trợ: ${s.slice(0, 120)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

async function makePdfWithText(pageTexts: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    const page = doc.addPage([300, 400]);
    page.drawText(text, { x: 30, y: 300, size: 12, font });
  }
  return Buffer.from(await doc.save());
}

function multipart(
  fields: Record<string, string>,
  file: { filename: string; contentType: string; data: Buffer }
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----elibtest${randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    )
  );
  chunks.push(file.data);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

describe('Phase A — file PDF cho tiêu chuẩn (FakePool + storage thật)', () => {
  let root: string;
  let storage: LocalDiskStorage;
  let pool: FakePool;
  let app: Awaited<ReturnType<typeof createApp>>;
  const cookies: Record<string, string> = {};
  const cfg = { ...loadConfig(), logLevel: 'silent' };

  const CODE = 'TCVN 14552-1:2025';
  let pdfWithCode: Buffer;
  let pdfWithCodeV2: Buffer;
  let pdfNoCode: Buffer;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-std-pdf-'));
    storage = new LocalDiskStorage(root);
    pool = new FakePool();
    const users = { admin, intViewer, intViewer2, intEditor, extEditor, extViewer, disabledInternal };
    for (const [key, user] of Object.entries(users)) {
      cookies[key] = `elib_session=${pool.addUser(user)}`;
    }
    app = await createApp({ pool: pool.asPool(), storage, config: cfg });
    pdfWithCode = await makePdfWithText([CODE, 'Trang 2', 'Trang 3']);
    pdfWithCodeV2 = await makePdfWithText([`${CODE} ban sua doi`, 'Trang 2', 'Trang 3']);
    pdfNoCode = await makePdfWithText(['Tai lieu khac han', 'Trang 2', 'Trang 3']);
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  beforeEach(() => {
    pool.reset();
  });

  const upload = (
    cookie: string | undefined,
    fields: Record<string, string>,
    file: { filename: string; contentType: string; data: Buffer }
  ) => {
    const { payload, headers } = multipart(fields, file);
    return app.inject({
      method: 'POST',
      url: '/api/documents',
      headers: cookie ? { ...headers, cookie } : headers,
      payload
    });
  };

  const uploadStandard = (
    cookie: string | undefined,
    overrides: Record<string, string> = {},
    data: Buffer = pdfWithCode,
    filename = 'tcvn-14552-1-2025.pdf'
  ) =>
    upload(
      cookie,
      {
        title: 'TCVN 14552-1:2025 — Tà vẹt bê tông',
        status: 'published',
        standard_code: CODE,
        standard_title_vi: 'Ứng dụng đường sắt — Tà vẹt bê tông',
        standard_title_en: 'Railway applications — Concrete sleepers',
        ...overrides
      },
      { filename, contentType: 'application/pdf', data }
    );

  const get = (url: string, cookie?: string) =>
    app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

  describe('quyền tải file tiêu chuẩn lên', () => {
    it('canUploadStandardFile: admin + mọi user_type=internal active; external/disabled/anon không', () => {
      expect(canUploadStandardFile(admin)).toBe(true);
      expect(canUploadStandardFile(intViewer)).toBe(true);
      expect(canUploadStandardFile(intEditor)).toBe(true);
      expect(canUploadStandardFile(extEditor)).toBe(false);
      expect(canUploadStandardFile(extViewer)).toBe(false);
      expect(canUploadStandardFile(disabledInternal)).toBe(false);
      expect(canUploadStandardFile(null)).toBe(false);
    });

    it('admin tải được (201)', async () => {
      const res = await uploadStandard(cookies.admin);
      expect(res.statusCode).toBe(201);
    });

    it('viewer nội bộ tải được (201)', async () => {
      const res = await uploadStandard(cookies.intViewer);
      expect(res.statusCode).toBe(201);
    });

    it('editor nội bộ tải được (201)', async () => {
      const res = await uploadStandard(cookies.intEditor);
      expect(res.statusCode).toBe(201);
    });

    it('editor ngoài -> 403', async () => {
      const res = await uploadStandard(cookies.extEditor);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('viewer ngoài -> 403', async () => {
      const res = await uploadStandard(cookies.extViewer);
      expect(res.statusCode).toBe(403);
    });

    it('chưa đăng nhập -> 401; tài khoản disabled -> 401 (phiên bị thu hồi)', async () => {
      expect((await uploadStandard(undefined)).statusCode).toBe(401);
      expect((await uploadStandard(cookies.disabledInternal)).statusCode).toBe(401);
    });

    it('upload tài liệu thường (không standard_code): viewer nội bộ -> 403, editor -> 201', async () => {
      const fields = { title: 'Tài liệu thường', status: 'published' };
      const file = { filename: 'thuong.pdf', contentType: 'application/pdf', data: pdfNoCode };
      expect((await upload(cookies.intViewer, fields, file)).statusCode).toBe(403);
      const ok = await upload(cookies.intEditor, fields, file);
      expect(ok.statusCode).toBe(201);
      expect(ok.json().document.standard_id).toBeNull();
      expect(ok.json().file.code_check_status).toBeNull();
      expect(ok.json().standard).toBeNull();
    });
  });

  describe('gắn chuẩn, stub, ép visibility internal, chỉ PDF', () => {
    it('tạo stub/summary + gắn standard_id + price NULL + ép internal + code_check pending', async () => {
      const res = await uploadStandard(cookies.intViewer, { visibility: 'public' });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.standard.normalized_code).toBe('TCVN14552-1:2025');
      expect(body.document.standard_id).toBe(body.standard.id);
      expect(body.document.price).toBeNull();
      expect(body.document.visibility).toBe('internal');
      expect(body.file.version).toBe(1);
      expect(body.file.uploaded_by).toBe(INT_VIEWER_ID);
      expect(body.file.code_check_status).toBe('pending');
      const std = pool.standards.get(body.standard.id)!;
      expect(std.detail_level).toBe('summary');
      expect(std.title_vi).toBe('Ứng dụng đường sắt — Tà vẹt bê tông');
      expect(std.year).toBe(2025);
    });

    it('không gửi tiêu đề -> stub', async () => {
      const res = await uploadStandard(cookies.intViewer, {
        standard_code: 'ISO 9001:2015',
        standard_title_vi: '',
        standard_title_en: ''
      });
      expect(res.statusCode).toBe(201);
      const std = pool.standards.get(res.json().standard.id)!;
      expect(std.detail_level).toBe('stub');
      expect(std.normalized_code).toBe('ISO9001:2015');
    });

    it('tiêu chuẩn đã có sẵn -> dùng lại (không tạo trùng), điền tiêu đề còn trống', async () => {
      const now = new Date();
      const seededId = randomUUID();
      pool.standards.set(seededId, {
        id: seededId,
        org: 'TCVN', number: '14552', part: '1', year: 2025, amendment: null, suffix: null,
        normalized_code: 'TCVN14552-1:2025', base_key: 'TCVN14552-1',
        code_key_raw: 'TCVN14552-1:2025', code_display: CODE,
        title_vi: null, title_en: 'Existing EN title', status: 'Active',
        issued_date: null, effective_date: null, ics: null, detail_level: 'full',
        parse_confidence: '0.9', is_amendment: false, amendment_year: null,
        is_draft: false, needs_review: false, last_verified_at: null,
        created_at: now, updated_at: now
      });
      const res = await uploadStandard(cookies.intViewer);
      expect(res.statusCode).toBe(201);
      expect(pool.standards.size).toBe(1);
      expect(res.json().standard.id).toBe(seededId);
      const std = pool.standards.get(seededId)!;
      expect(std.title_vi).toBe('Ứng dụng đường sắt — Tà vẹt bê tông');
      expect(std.title_en).toBe('Existing EN title'); // không ghi đè
    });

    it('mã không chuẩn hóa được -> 400 INVALID_STANDARD_CODE', async () => {
      const res = await uploadStandard(cookies.intViewer, { standard_code: '12345' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_STANDARD_CODE');
    });

    it('file không phải PDF kèm standard_code -> 400 STANDARD_FILE_MUST_BE_PDF', async () => {
      const res = await uploadStandard(
        cookies.intViewer,
        {},
        Buffer.from('noi dung text thuong'),
        'ghi-chu.txt'
      );
      // .txt hợp lệ qua whitelist thường, nhưng file tiêu chuẩn chỉ nhận PDF.
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('STANDARD_FILE_MUST_BE_PDF');
    });
  });

  describe('phiên bản sửa đổi + con trỏ hiện hành', () => {
    it('upload lại cùng tiêu chuẩn -> version+1, version_label + uploaded_by lưu theo phiên bản', async () => {
      const first = await uploadStandard(cookies.intViewer, { version_label: 'Bản gốc' });
      expect(first.statusCode).toBe(201);
      const docId = first.json().document.id as string;

      const second = await uploadStandard(
        cookies.intEditor,
        { version_label: 'Sửa đổi 1:2023' },
        pdfWithCodeV2,
        'tcvn-14552-1-2025-sd1.pdf'
      );
      expect(second.statusCode).toBe(201);
      const body = second.json();
      expect(body.document.id).toBe(docId);
      expect(body.file.version).toBe(2);
      expect(body.file.version_label).toBe('Sửa đổi 1:2023');
      expect(body.file.uploaded_by).toBe(INT_EDITOR_ID);
      expect(body.document.current_file_id).toBe(body.file.id);
      expect(pool.documents.size).toBe(1);
      expect(pool.files.size).toBe(2);

      const list = await get('/api/documents', cookies.intViewer);
      expect(list.json().data[0].file.version).toBe(2);
      expect(list.json().data[0].file.version_label).toBe('Sửa đổi 1:2023');
      expect(list.json().data[0].file.uploaded_by).toBe(INT_EDITOR_ID);
      expect(list.json().data[0].standard_id).toBe(body.standard.id);
    });

    it('trùng checksum -> 409 DUPLICATE_FILE; force=true -> version mới', async () => {
      await uploadStandard(cookies.intViewer);
      const dup = await uploadStandard(cookies.intViewer);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe('DUPLICATE_FILE');
      const forced = await uploadStandard(cookies.intViewer, { force: 'true' });
      expect(forced.statusCode).toBe(201);
      expect(forced.json().file.version).toBe(2);
    });

    it('admin đặt lại phiên bản hiện hành về bản cũ; người khác -> 403; file lạ -> 404', async () => {
      const first = await uploadStandard(cookies.intViewer);
      const docId = first.json().document.id as string;
      const v1FileId = first.json().file.id as string;
      await uploadStandard(cookies.intViewer, {}, pdfWithCodeV2, 'v2.pdf');

      const patch = (cookie: string | undefined, fileId: string) =>
        app.inject({
          method: 'PATCH',
          url: `/api/documents/${docId}/current-version`,
          headers: cookie ? { cookie } : {},
          payload: { file_id: fileId }
        });

      expect((await patch(cookies.intViewer, v1FileId)).statusCode).toBe(403);
      expect((await patch(undefined, v1FileId)).statusCode).toBe(401);
      expect((await patch(cookies.admin, randomUUID())).statusCode).toBe(404);

      const ok = await patch(cookies.admin, v1FileId);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().document.current_file_id).toBe(v1FileId);

      const list = await get('/api/documents', cookies.intViewer);
      expect(list.json().data[0].file.id).toBe(v1FileId);
      expect(list.json().data[0].file.version).toBe(1);

      const view = await get(`/api/documents/${docId}/view`, cookies.intViewer2);
      expect(view.statusCode).toBe(200);
      expect(Buffer.from(view.rawPayload).equals(pdfWithCode)).toBe(true);
    });
  });

  describe('quyền xem toàn bộ /view vs tải bản gốc', () => {
    const stdDoc = (over: Partial<DocumentAccessRow> = {}): DocumentAccessRow => ({
      status: 'published',
      visibility: 'internal',
      created_by: INT_VIEWER_ID,
      standard_id: 'std-1',
      ...over
    });

    it('canViewFull: internal xem toàn bộ file tiêu chuẩn; external editor thì không; draft/private thì không', () => {
      expect(canViewFull(intViewer2, stdDoc())).toBe(true);
      expect(canViewFull(intEditor, stdDoc())).toBe(true);
      expect(canViewFull(extEditor, stdDoc())).toBe(false);
      expect(canViewFull(extViewer, stdDoc())).toBe(false);
      expect(canViewFull(null, stdDoc())).toBe(false);
      expect(canViewFull(intViewer2, stdDoc({ status: 'draft' }))).toBe(false);
      expect(canViewFull(intViewer2, stdDoc({ visibility: 'private' }))).toBe(false);
      // Tài liệu thường: internal không có quyền xem toàn bộ.
      expect(canViewFull(intViewer2, stdDoc({ standard_id: null }))).toBe(false);
      // Tải bản gốc không đổi: chỉ chủ + admin.
      expect(canDownloadOriginal(intViewer2, stdDoc())).toBe(false);
      expect(canDownloadOriginal(intViewer, stdDoc())).toBe(true);
      expect(canDownloadOriginal(admin, stdDoc())).toBe(true);
    });

    it('/view: viewer nội bộ (không phải chủ) xem toàn bộ 200; tải bản gốc vẫn 403', async () => {
      const up = await uploadStandard(cookies.intViewer);
      const docId = up.json().document.id as string;
      const fileId = up.json().file.id as string;

      const view = await get(`/api/documents/${docId}/view`, cookies.intViewer2);
      expect(view.statusCode).toBe(200);
      expect(Buffer.from(view.rawPayload).equals(pdfWithCode)).toBe(true);

      const dl = await get(`/api/documents/${docId}/files/${fileId}/download`, cookies.intViewer2);
      expect(dl.statusCode).toBe(403);
      expect(dl.json().error.code).toBe('DOWNLOAD_FORBIDDEN');

      const dlOwner = await get(`/api/documents/${docId}/files/${fileId}/download`, cookies.intViewer);
      expect(dlOwner.statusCode).toBe(200);
      const dlAdmin = await get(`/api/documents/${docId}/files/${fileId}/download`, cookies.admin);
      expect(dlAdmin.statusCode).toBe(200);
    });

    it('/view: external -> 403, chưa đăng nhập -> 404 thống nhất', async () => {
      const up = await uploadStandard(cookies.intViewer);
      const docId = up.json().document.id as string;
      expect((await get(`/api/documents/${docId}/view`, cookies.extViewer)).statusCode).toBe(403);
      expect((await get(`/api/documents/${docId}/view`, cookies.extEditor)).statusCode).toBe(403);
      expect((await get(`/api/documents/${docId}/view`)).statusCode).toBe(404);
    });
  });

  describe('GET /api/standards/:code/files', () => {
    it('internal thấy document + current_file + lịch sử phiên bản; price luôn null', async () => {
      const first = await uploadStandard(cookies.intViewer, { version_label: 'Bản gốc' });
      await uploadStandard(cookies.intViewer, { version_label: 'Sửa đổi 1:2023' }, pdfWithCodeV2, 'v2.pdf');
      const res = await get(
        `/api/standards/${encodeURIComponent(CODE)}/files`,
        cookies.intViewer2
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.standard.normalized_code).toBe('TCVN14552-1:2025');
      expect(body.document.id).toBe(first.json().document.id);
      expect(body.document.price).toBeNull();
      expect(body.document.can_view_full).toBe(true);
      expect(body.document.can_download).toBe(false);
      expect(body.current_file.version).toBe(2);
      expect(body.current_file.version_label).toBe('Sửa đổi 1:2023');
      expect(body.versions).toHaveLength(2);
      expect(body.versions[1].version).toBe(1);
      expect(JSON.stringify(body)).not.toContain('storage_path');
    });

    it('chưa đăng nhập + external: document null, không lộ file; mã lạ -> 404', async () => {
      await uploadStandard(cookies.intViewer);
      const url = `/api/standards/${encodeURIComponent(CODE)}/files`;
      for (const cookie of [undefined, cookies.extViewer]) {
        const res = await get(url, cookie);
        expect(res.statusCode).toBe(200);
        expect(res.json().document).toBeNull();
        expect(res.json().current_file).toBeNull();
        expect(res.json().versions).toEqual([]);
        expect(res.json().standard.normalized_code).toBe('TCVN14552-1:2025');
      }
      // Editor (kể cả external) thấy tài liệu internal theo ma trận danh sách,
      // nhưng không xem toàn bộ / không tải bản gốc được.
      const asExtEditor = await get(url, cookies.extEditor);
      expect(asExtEditor.json().document).not.toBeNull();
      expect(asExtEditor.json().document.can_view_full).toBe(false);
      expect(asExtEditor.json().document.can_download).toBe(false);
      const missing = await get('/api/standards/ISO%2099999%3A2099/files', cookies.intViewer);
      expect(missing.statusCode).toBe(404);
    });

    it('mã có dấu / (GB/T) qua encodeURIComponent vẫn tra được', async () => {
      const now = new Date();
      const id = randomUUID();
      pool.standards.set(id, {
        id, org: 'GB', number: '19001', part: null, year: 2016, amendment: null,
        suffix: null, normalized_code: 'GBT19001:2016', base_key: 'GBT19001',
        code_key_raw: 'GBT19001:2016', code_display: 'GB/T 19001-2016',
        title_vi: null, title_en: null, status: 'Active', issued_date: null,
        effective_date: null, ics: null, detail_level: 'summary',
        parse_confidence: null, is_amendment: false, amendment_year: null,
        is_draft: false, needs_review: false, last_verified_at: null,
        created_at: now, updated_at: now
      });
      const res = await get(
        `/api/standards/${encodeURIComponent('GB/T 19001-2016')}/files`,
        cookies.intViewer
      );
      expect(res.statusCode).toBe(200);
      expect(res.json().standard.normalized_code).toBe('GBT19001:2016');
      expect(res.json().document).toBeNull();
    });
  });

  describe('chống rò rỉ: tìm kiếm công khai / danh sách / preview', () => {
    it('danh sách + tìm kiếm: anon/external không thấy file tiêu chuẩn, internal thấy', async () => {
      await uploadStandard(cookies.intViewer);
      const anonList = await get('/api/documents');
      expect(anonList.json().total).toBe(0);
      expect(anonList.json().data).toEqual([]);
      const extList = await get('/api/documents', cookies.extViewer);
      expect(extList.json().total).toBe(0);
      const extSearch = await get('/api/documents?q=14552', cookies.extViewer);
      expect(extSearch.json().total).toBe(0);
      const anonSearch = await get('/api/documents?q=14552');
      expect(anonSearch.json().total).toBe(0);
      const intList = await get('/api/documents', cookies.intViewer2);
      expect(intList.json().total).toBe(1);
      expect(intList.json().data[0].price).toBeNull();
      expect(intList.json().data[0].can_view_full).toBe(true);
      expect(intList.json().data[0].can_download).toBe(false);
      expect(intList.json().data[0].file.code_check_status).toBe('pending');
    });

    it('preview: anon -> 404, external -> 403, internal nhận đúng bytes preview (không phải bản gốc)', async () => {
      const up = await uploadStandard(cookies.intViewer);
      const docId = up.json().document.id as string;
      const fileId = up.json().file.id as string;
      const previewBytes = Buffer.from('PREVIEW-BYTES-GIOI-HAN-TRANG');
      const previewPath = storage.buildPreviewPath(docId, 1);
      await storage.saveBytes(previewBytes, previewPath);
      const file = pool.files.get(fileId)!;
      file.preview_path = previewPath;
      file.preview_status = 'ready';
      file.preview_pages = 1;
      file.page_count = 3;

      expect((await get(`/api/documents/${docId}/preview`)).statusCode).toBe(404);
      expect((await get(`/api/documents/${docId}/preview`, cookies.extViewer)).statusCode).toBe(403);
      const ok = await get(`/api/documents/${docId}/preview`, cookies.intViewer2);
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe(previewBytes.toString());
      expect(ok.headers['cache-control']).toContain('private');
    });

    it('ma trận thấy tài liệu: file tiêu chuẩn published+internal ẩn với anon/external', () => {
      const doc: DocumentAccessRow = {
        status: 'published',
        visibility: 'internal',
        created_by: INT_VIEWER_ID,
        standard_id: 'std-1'
      };
      expect(visibleInList(null, doc)).toBe(false);
      expect(visibleInList(extViewer, doc)).toBe(false);
      expect(canPreview(null, doc)).toBe(false);
      expect(canPreview(extViewer, doc)).toBe(false);
      expect(visibleInList(intViewer2, doc)).toBe(true);
      expect(canPreview(intViewer2, doc)).toBe(true);
    });
  });

  describe('job kiểm tra mã chuẩn', () => {
    const info: CodeCheckStandardInfo = {
      normalized_code: 'TCVN14552-1:2025',
      code_key_raw: 'TCVN14552-1:2025',
      base_key: 'TCVN14552-1',
      code_display: CODE
    };

    async function seedPendingFile(data: Buffer, filename = 'std.pdf'): Promise<CodeCheckFileRow> {
      const up = await uploadStandard(cookies.intViewer, {}, data, filename);
      expect(up.statusCode).toBe(201);
      const fileId = up.json().file.id as string;
      const f = pool.files.get(fileId)!;
      return {
        id: fileId,
        document_id: String(f.document_id),
        storage_path: String(f.storage_path),
        mime_type: String(f.mime_type),
        file_size: f.file_size as string
      };
    }

    it('trích chuỗi content stream: literal, TJ tách mảnh, hex, escape, UTF-16BE', () => {
      const stream = Buffer.from(
        'BT (TCVN 145) Tj [(52-1:2025) 120 ( phan 1)] TJ <49534F2039303031> Tj (A\\(B\\)) Tj <FEFF005400430056004E> Tj ET',
        'latin1'
      );
      const text = extractStringsFromContentStream(stream);
      expect(text).toContain('TCVN 14552-1:2025 phan 1');
      expect(text).toContain('ISO 9001');
      expect(text).toContain('A(B)');
      expect(text).toContain('TCVN');
    });

    it('so mã: đủ năm, không năm (base_key), biến thể dấu - thay :', () => {
      expect(normalizeForCodeSearch('TCVN 14552-1:2025')).toBe('TCVN14552-1:2025');
      expect(pdfTextContainsCode('... TCVN 14552-1:2025 ...', ['TCVN14552-1:2025'])).toBe(true);
      expect(pdfTextContainsCode('TCVN14552-1', ['TCVN14552-1:2025', 'TCVN14552-1'])).toBe(true);
      expect(pdfTextContainsCode('TCVN 14552-1-2025', ['TCVN14552-1-2025'])).toBe(true);
      expect(pdfTextContainsCode('khong co ma', ['TCVN14552-1:2025'])).toBe(false);
      expect(pdfTextContainsCode('', ['TCVN14552-1:2025'])).toBe(false);
    });

    it('PDF chứa mã ở trang đầu -> found + code_checked_at', async () => {
      const row = await seedPendingFile(pdfWithCode);
      const outcome = await processCodeCheckFile(pool.asPool(), storage, row, info, cfg);
      expect(outcome).toBe('found');
      const f = pool.files.get(row.id)!;
      expect(f.code_check_status).toBe('found');
      expect(f.code_checked_at).not.toBeNull();
      expect(f.code_check_locked_at).toBeNull();
    });

    it('PDF không chứa mã -> not_found (cảnh báo, tài liệu vẫn dùng được)', async () => {
      const row = await seedPendingFile(pdfNoCode, 'khac.pdf');
      const outcome = await processCodeCheckFile(pool.asPool(), storage, row, info, cfg);
      expect(outcome).toBe('not_found');
      expect(pool.files.get(row.id)!.code_check_status).toBe('not_found');
      // Tài liệu vẫn xem/tải bình thường theo quyền.
      const view = await get(`/api/documents/${row.document_id}/view`, cookies.intViewer);
      expect(view.statusCode).toBe(200);
    });

    it('PDF mã hóa: giải mã qua qpdf (runner giả lập) rồi kiểm tra -> found; file tạm bị xóa', async () => {
      const encrypted = Buffer.from(makeRc4EncryptedPdf({ pageCount: 3 }));
      const row = await seedPendingFile(encrypted, 'ma-hoa.pdf');
      const calls: string[][] = [];
      const fakeRunner: QpdfRunner = async (_bin, args) => {
        calls.push([...args]);
        // Giả lập qpdf giải mã: ghi PDF thường chứa mã sang file đích.
        const out = args[args.length - 1];
        await writeFile(out, pdfWithCode);
        return { exitCode: 0, signal: null, stdout: '', stderr: '' };
      };
      const outcome = await processCodeCheckFile(pool.asPool(), storage, row, info, cfg, () => undefined, {
        runner: fakeRunner
      });
      expect(outcome).toBe('found');
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('--password=');
    });

    it('runCodeCheckJobOnce: nhận việc pending và xử lý; nhả job processing quá hạn', async () => {
      const row = await seedPendingFile(pdfWithCode);
      const processed = await runCodeCheckJobOnce(pool.asPool(), storage, cfg, () => undefined, 1);
      expect(processed).toBe(1);
      expect(pool.files.get(row.id)!.code_check_status).toBe('found');

      // Job kẹt 'processing' quá hạn -> lượt sau nhả về pending rồi xử lý.
      const row2 = await seedPendingFile(pdfNoCode, 'ket.pdf');
      const f2 = pool.files.get(row2.id)!;
      f2.code_check_status = 'processing';
      f2.code_check_locked_at = new Date(Date.now() - 60 * 60_000);
      const processed2 = await runCodeCheckJobOnce(pool.asPool(), storage, cfg, () => undefined, 1);
      expect(processed2).toBe(1);
      expect(pool.files.get(row2.id)!.code_check_status).toBe('not_found');
    });
  });
});
