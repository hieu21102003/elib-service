import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { CurrentUser, DocumentAccessRow, UserRole } from '../src/auth/session.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { visibleInList } from '../src/documents/visibility.js';
import type { QpdfRunner } from '../src/previews/qpdf.js';
import { LocalDiskStorage } from '../src/storage/local-disk.js';
import { runTocBackfill } from '../src/toc/backfill.js';
import {
  claimNextTocJob,
  processTocFile,
  releaseStaleTocJobs,
  runTocJobOnce,
  type TocJobRow,
} from '../src/toc/job.js';
import type { TocAutoPayload, TocManualPayload } from '../src/toc/types.js';
import { TOC_ALGORITHM_VERSION } from '../src/toc/version.js';
import { makeRc4EncryptedPdf } from './helpers/encrypted-pdf.js';

const ADMIN_ID = 'b1111111-1111-4111-8111-111111111111';
const INT_VIEWER_ID = 'b2222222-2222-4222-8222-222222222222';
const INT_EDITOR_ID = 'b3333333-3333-4333-8333-333333333333';
const EXT_VIEWER_ID = 'b4444444-4444-4444-8444-444444444444';
const EXT_EDITOR_ID = 'b5555555-5555-4555-8555-555555555555';
const MUST_CHANGE_ADMIN_ID = 'b6666666-6666-4666-8666-666666666666';

function makeUser(
  role: UserRole,
  id: string,
  userType: CurrentUser['userType'],
  opts: { status?: CurrentUser['status']; mustChangePassword?: boolean } = {}
): CurrentUser {
  return {
    id,
    username: null,
    email: `${role}-${id.slice(0, 4)}@congty.vn`,
    role,
    displayName: null,
    userType,
    status: opts.status ?? 'active',
    mustChangePassword: opts.mustChangePassword ?? false,
  };
}

const USERS = {
  admin: makeUser('admin', ADMIN_ID, 'internal'),
  intViewer: makeUser('viewer', INT_VIEWER_ID, 'internal'),
  intEditor: makeUser('editor', INT_EDITOR_ID, 'internal'),
  extViewer: makeUser('viewer', EXT_VIEWER_ID, 'external'),
  extEditor: makeUser('editor', EXT_EDITOR_ID, 'external'),
  mustChangeAdmin: makeUser('admin', MUST_CHANGE_ADMIN_ID, 'internal', { mustChangePassword: true }),
};

const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

type Row = Record<string, unknown>;

function safeClone<T>(val: T): T {
  if (val === null || val === undefined) return val;
  return JSON.parse(JSON.stringify(val)) as T;
}

class FakeTocPool {
  tokens = new Map<string, CurrentUser>();
  standards = new Map<string, Row>();
  documents = new Map<string, Row>();
  files = new Map<string, Row>();
  tocs = new Map<string, Row>();
  tagsByNormalized = new Map<string, Row>();
  docTags = new Map<string, Set<string>>();

  addUser(user: CurrentUser): string {
    const raw = `token-${user.id}`;
    this.tokens.set(hashToken(raw), user);
    return raw;
  }

  reset(): void {
    this.standards.clear();
    this.documents.clear();
    this.files.clear();
    this.tocs.clear();
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
      email: 'u@congty.vn',
      role: role as UserRole,
      displayName: null,
      userType: (userType as CurrentUser['userType']) ?? null,
      status: 'active',
      mustChangePassword: false,
    };
  }

  private buildPublicTocRow(doc: Row, f: Row | null): Row {
    const toc = f ? this.tocs.get(String(f.id)) : undefined;
    return {
      doc_id: doc.id,
      status: doc.status,
      visibility: doc.visibility,
      standard_id: doc.standard_id ?? null,
      current_file_id: doc.current_file_id ?? null,
      created_by: doc.created_by,
      file_id: f?.id ?? null,
      version: f?.version ?? null,
      version_label: f?.version_label ?? null,
      uploaded_by: f?.uploaded_by ?? null,
      uploaded_at: f?.uploaded_at ?? null,
      mime_type: f?.mime_type ?? null,
      page_count: f?.page_count ?? null,
      preview_pages: f?.preview_pages ?? null,
      toc_file_id: toc?.file_id ?? null,
      job_status: toc?.job_status ?? null,
      auto_status: toc?.auto_status ?? null,
      auto_strategy: toc?.auto_strategy ?? null,
      auto_flags: safeClone((toc?.auto_flags as string[] | null) ?? []),
      auto_payload: safeClone(toc?.auto_payload ?? null),
      algorithm_version: toc?.algorithm_version ?? null,
      manual_override: toc?.manual_override ?? null,
      manual_payload: safeClone(toc?.manual_payload ?? null),
    };
  }

  private buildAdminTocRow(f: Row): Row {
    const doc = this.documents.get(String(f.document_id))!;
    const std = doc.standard_id ? this.standards.get(String(doc.standard_id)) : undefined;
    const toc = this.tocs.get(String(f.id));
    return {
      file_id: f.id,
      document_id: f.document_id,
      standard_id: doc.standard_id ?? null,
      current_file_id: doc.current_file_id ?? null,
      document_title: doc.title,
      is_current_version: doc.current_file_id === f.id,
      standard_code_display: std?.code_display ?? null,
      version: f.version,
      version_label: f.version_label ?? null,
      uploaded_by: f.uploaded_by ?? null,
      uploaded_at: f.uploaded_at ?? null,
      original_filename: f.original_filename,
      mime_type: f.mime_type,
      page_count: f.page_count ?? null,
      toc_file_id: toc?.file_id ?? null,
      job_status: toc?.job_status ?? null,
      attempts: toc?.attempts ?? 0,
      locked_at: toc?.locked_at ?? null,
      last_error: toc?.last_error ?? null,
      auto_status: toc?.auto_status ?? null,
      auto_strategy: toc?.auto_strategy ?? null,
      auto_flags: safeClone((toc?.auto_flags as string[] | null) ?? []),
      auto_payload: safeClone(toc?.auto_payload ?? null),
      algorithm_version: toc?.algorithm_version ?? null,
      extracted_at: toc?.extracted_at ?? null,
      manual_override: toc?.manual_override ?? false,
      manual_payload: safeClone(toc?.manual_payload ?? null),
      manual_updated_by: toc?.manual_updated_by ?? null,
      manual_updated_at: toc?.manual_updated_at ?? null,
    };
  }

  private filterAdminRows(s: string, params: unknown[]): Row[] {
    let idx = 1; // $1 is mime_type
    const mime = String(params[0]);
    let autoStatus: string | null = null;
    let flag: string | null = null;
    let jobStatus: string | null = null;
    let manualOverride: boolean | null = null;
    let algoCheck: string | null = null;

    if (s.includes('t.auto_status = $')) autoStatus = String(params[idx++]);
    if (s.includes('= ANY(t.auto_flags)')) flag = String(params[idx++]);
    if (s.includes('t.job_status = $')) jobStatus = String(params[idx++]);
    if (s.includes('COALESCE(t.manual_override, false) = $')) manualOverride = Boolean(params[idx++]);
    const standardsOnly = s.includes('d.standard_id IS NOT NULL')
      ? true
      : s.includes('d.standard_id IS NULL')
        ? false
        : null;
    if (s.includes('t.algorithm_version IS DISTINCT FROM $')) algoCheck = String(params[idx++]);

    return [...this.files.values()]
      .filter((f) => {
        if (f.mime_type !== mime) return false;
        const doc = this.documents.get(String(f.document_id));
        if (!doc) return false;
        const toc = this.tocs.get(String(f.id));
        if (autoStatus !== null && toc?.auto_status !== autoStatus) return false;
        if (flag !== null && !((toc?.auto_flags as string[] | undefined) ?? []).includes(flag)) {
          return false;
        }
        if (jobStatus !== null && toc?.job_status !== jobStatus) return false;
        if (manualOverride !== null && Boolean(toc?.manual_override) !== manualOverride) return false;
        if (standardsOnly === true && !doc.standard_id) return false;
        if (standardsOnly === false && doc.standard_id) return false;
        if (algoCheck !== null && toc?.algorithm_version === algoCheck) return false;
        return true;
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
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
                must_change_password: user.mustChangePassword,
              },
            ]
          : [],
      };
    }

    if (s.includes('SELECT id FROM categories WHERE id')) return { rows: [] };

    if (s.includes('WHERE f.checksum_sha256 = $1')) {
      const file = [...this.files.values()].find((f) => f.checksum_sha256 === params[0]);
      if (!file) return { rows: [] };
      const doc = this.documents.get(String(file.document_id));
      return {
        rows: [{ document_id: file.document_id, title: doc?.title ?? '', file_id: file.id }],
      };
    }

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
        parse_confidence, is_amendment, amendment_year, is_draft, needs_review,
      ] = params;
      if ([...this.standards.values()].some((r) => r.normalized_code === normalized_code)) {
        return { rows: [] };
      }
      const now = new Date();
      const row: Row = {
        id: randomUUID(),
        org, number, part, year, amendment, suffix, normalized_code, base_key,
        code_key_raw, code_display, title_vi, title_en, status: 'Unknown',
        detail_level, parse_confidence: parse_confidence === null ? null : String(parse_confidence),
        is_amendment, amendment_year, is_draft, needs_review,
        created_at: now, updated_at: now,
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

    if (s.includes('FROM documents WHERE standard_id = $1')) {
      const doc = [...this.documents.values()]
        .filter((d) => d.standard_id === params[0])
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
      return { rows: doc ? [{ ...doc }] : [] };
    }

    if (s.includes('MAX(version)')) {
      const files = this.filesOf(String(params[0]));
      return { rows: [{ next_version: (files[0] ? Number(files[0].version) : 0) + 1 }] };
    }

    if (s.includes('SELECT id FROM documents WHERE slug')) {
      const doc = [...this.documents.values()].find((d) => d.slug === params[0]);
      return { rows: doc ? [{ id: doc.id }] : [] };
    }

    if (s.includes('INSERT INTO documents')) {
      const [
        id, title, slug, description, category_id, doc_type, language,
        visibility, status, standard_id, created_by,
      ] = params;
      const now = new Date();
      const row: Row = {
        id, title, slug, description, category_id, doc_type, language,
        visibility, status, price: null, standard_id, current_file_id: null,
        created_by, created_at: now, updated_at: now,
      };
      this.documents.set(String(id), row);
      return { rows: [{ ...row }] };
    }

    if (s.includes('INSERT INTO document_files')) {
      const [
        id, document_id, version, storage_path, original_filename, mime_type,
        file_size, checksum_sha256, preview_status, version_label, uploaded_by,
        code_check_status,
      ] = params;
      const now = new Date();
      const row: Row = {
        id, document_id, version, storage_path, original_filename, mime_type,
        file_size, checksum_sha256, page_count: null, preview_status,
        preview_path: null, preview_pages: null, version_label, uploaded_by,
        uploaded_at: now, code_check_status, code_checked_at: null, created_at: now,
      };
      this.files.set(String(id), row);
      return { rows: [{ ...row }] };
    }

    if (s.includes('UPDATE documents SET current_file_id = $1, updated_at = now() WHERE id = $2')) {
      const doc = this.documents.get(String(params[1]));
      if (!doc) return { rows: [] };
      doc.current_file_id = params[0];
      doc.updated_at = new Date();
      return { rows: [{ ...doc }] };
    }

    if (s.includes('UPDATE documents SET current_file_id = $1 WHERE id = $2')) {
      const doc = this.documents.get(String(params[1]));
      if (doc) doc.current_file_id = params[0];
      return { rows: [] };
    }

    if (s.includes('INSERT INTO tags') || s.includes('INSERT INTO document_tags')) {
      return { rows: [{ id: randomUUID() }] };
    }

    if (s.includes('SELECT id, current_file_id FROM documents WHERE id = $1')) {
      const doc = this.documents.get(String(params[0]));
      return { rows: doc ? [{ id: doc.id, current_file_id: doc.current_file_id }] : [] };
    }

    if (s.includes('SELECT id, version FROM document_files WHERE id = $1 AND document_id = $2')) {
      const f = this.files.get(String(params[0]));
      if (!f || f.document_id !== params[1]) return { rows: [] };
      return { rows: [{ id: f.id, version: f.version }] };
    }

    if (s.includes('UPDATE document_files SET page_count = $2 WHERE id = $1 AND page_count IS NULL')) {
      const f = this.files.get(String(params[0]));
      if (f && f.page_count === null) f.page_count = params[1];
      return { rows: [] };
    }

    // --- TOC tables: enqueue / job / admin / backfill ---
    if (s.startsWith('INSERT INTO document_file_tocs (file_id, job_status) VALUES')) {
      const fileId = String(params[0]);
      if (!this.tocs.has(fileId)) {
        this.tocs.set(fileId, {
          file_id: fileId,
          job_status: 'pending',
          locked_at: null,
          attempts: 0,
          last_error: null,
          auto_status: null,
          auto_strategy: null,
          auto_flags: [],
          auto_payload: null,
          algorithm_version: null,
          extracted_at: null,
          manual_override: false,
          manual_payload: null,
          manual_updated_by: null,
          manual_updated_at: null,
        });
      }
      return { rows: [] };
    }

    if (s.startsWith('INSERT INTO document_file_tocs (file_id, job_status, last_error') ||
        s.startsWith('INSERT INTO document_file_tocs (file_id, job_status, locked_at, last_error')) {
      const [fileId, jobStatus, lastError, autoStatus, autoStrategy, autoFlags, autoPayloadJson, algoVer] =
        params;
      const existing = this.tocs.get(String(fileId));
      const now = new Date();
      this.tocs.set(String(fileId), {
        file_id: String(fileId),
        job_status: jobStatus,
        locked_at: null,
        attempts: existing?.attempts ?? 0,
        last_error: lastError,
        auto_status: autoStatus,
        auto_strategy: autoStrategy,
        auto_flags: autoFlags ?? [],
        auto_payload: autoPayloadJson ? JSON.parse(String(autoPayloadJson)) : null,
        algorithm_version: algoVer,
        extracted_at: now,
        manual_override: existing?.manual_override ?? false,
        manual_payload: existing?.manual_payload ?? null,
        manual_updated_by: existing?.manual_updated_by ?? null,
        manual_updated_at: existing?.manual_updated_at ?? null,
      });
      return { rows: [] };
    }

    if (s.startsWith('INSERT INTO document_file_tocs (file_id, job_status, manual_override')) {
      const [fileId, jobStatus, manualJson, userId] = params;
      const existing = this.tocs.get(String(fileId));
      const now = new Date();
      this.tocs.set(String(fileId), {
        file_id: String(fileId),
        job_status: existing?.job_status ?? jobStatus,
        locked_at: existing?.locked_at ?? null,
        attempts: existing?.attempts ?? 0,
        last_error: existing?.last_error ?? null,
        auto_status: existing?.auto_status ?? null,
        auto_strategy: existing?.auto_strategy ?? null,
        auto_flags: existing?.auto_flags ?? [],
        auto_payload: existing?.auto_payload ?? null,
        algorithm_version: existing?.algorithm_version ?? null,
        extracted_at: existing?.extracted_at ?? null,
        manual_override: true,
        manual_payload: JSON.parse(String(manualJson)),
        manual_updated_by: userId,
        manual_updated_at: now,
      });
      return { rows: [] };
    }

    if (s.startsWith('INSERT INTO document_file_tocs (file_id, job_status, attempts, locked_at')) {
      const fileId = String(params[0]);
      const existing = this.tocs.get(fileId);
      this.tocs.set(fileId, {
        file_id: fileId,
        job_status: 'pending',
        locked_at: null,
        attempts: 0,
        last_error: null,
        auto_status: existing?.auto_status ?? null,
        auto_strategy: existing?.auto_strategy ?? null,
        auto_flags: existing?.auto_flags ?? [],
        auto_payload: existing?.auto_payload ?? null,
        algorithm_version: existing?.algorithm_version ?? null,
        extracted_at: existing?.extracted_at ?? null,
        manual_override: existing?.manual_override ?? false,
        manual_payload: existing?.manual_payload ?? null,
        manual_updated_by: existing?.manual_updated_by ?? null,
        manual_updated_at: existing?.manual_updated_at ?? null,
      });
      return { rows: [] };
    }

    if (s.includes('UPDATE document_file_tocs SET manual_override = $2, manual_payload = $3::jsonb')) {
      const toc = this.tocs.get(String(params[0]));
      if (toc) {
        toc.manual_override = Boolean(params[1]);
        toc.manual_payload = JSON.parse(String(params[2]));
        toc.manual_updated_by = params[3];
        toc.manual_updated_at = new Date();
      }
      return { rows: [] };
    }

    if (s.includes('UPDATE document_file_tocs SET manual_override = false, manual_payload = NULL')) {
      const toc = this.tocs.get(String(params[0]));
      if (toc) {
        toc.manual_override = false;
        toc.manual_payload = null;
        toc.manual_updated_by = params[1];
        toc.manual_updated_at = new Date();
      }
      return { rows: [] };
    }

    if (s.startsWith("UPDATE document_file_tocs SET job_status = 'failed'")) {
      const staleMinutes = Number(params[0]);
      const maxAttempts = Number(params[1]);
      const cutoff = Date.now() - staleMinutes * 60_000;
      let n = 0;
      for (const toc of this.tocs.values()) {
        const locked = toc.locked_at as Date | null;
        if (
          toc.job_status === 'processing' &&
          locked &&
          locked.getTime() < cutoff &&
          Number(toc.attempts ?? 0) >= maxAttempts
        ) {
          toc.job_status = 'failed';
          toc.auto_status = 'failed';
          toc.auto_strategy = toc.auto_strategy ?? 'failed';
          toc.locked_at = null;
          toc.last_error = 'toc_job_stale_timeout';
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (s.startsWith("UPDATE document_file_tocs SET job_status = 'pending'")) {
      const staleMinutes = Number(params[0]);
      const maxAttempts = Number(params[1]);
      const cutoff = Date.now() - staleMinutes * 60_000;
      let n = 0;
      for (const toc of this.tocs.values()) {
        const locked = toc.locked_at as Date | null;
        if (
          toc.job_status === 'processing' &&
          locked &&
          locked.getTime() < cutoff &&
          Number(toc.attempts ?? 0) < maxAttempts
        ) {
          toc.job_status = 'pending';
          toc.locked_at = null;
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }

    if (s.startsWith("UPDATE document_file_tocs t SET job_status = 'processing'")) {
      const candidates = [...this.tocs.values()]
        .filter((t) => t.job_status === 'pending' && this.files.has(String(t.file_id)))
        .sort((a, b) => {
          const fa = this.files.get(String(a.file_id))!;
          const fb = this.files.get(String(b.file_id))!;
          return String(fa.created_at).localeCompare(String(fb.created_at));
        });
      const toc = candidates[0];
      if (!toc) return { rows: [] };
      toc.job_status = 'processing';
      toc.locked_at = new Date();
      toc.attempts = Number(toc.attempts ?? 0) + 1;
      const f = this.files.get(String(toc.file_id))!;
      const doc = this.documents.get(String(f.document_id))!;
      return {
        rows: [
          {
            file_id: f.id,
            document_id: f.document_id,
            version: f.version,
            storage_path: f.storage_path,
            mime_type: f.mime_type,
            file_size: f.file_size,
            page_count: f.page_count,
            attempts: toc.attempts,
            standard_id: doc.standard_id ?? null,
          },
        ],
      };
    }

    // Public read: specific version
    if (s.includes('t.file_id AS toc_file_id') && s.includes('AND df.id = $2')) {
      const doc = this.documents.get(String(params[0]));
      const f = this.files.get(String(params[1]));
      if (!doc || !f || f.document_id !== doc.id) return { rows: [] };
      return { rows: [this.buildPublicTocRow(doc, f)] };
    }

    // Public read: current version
    if (s.includes('t.file_id AS toc_file_id') && s.includes('LEFT JOIN LATERAL')) {
      const doc = this.documents.get(String(params[0]));
      if (!doc) return { rows: [] };
      return { rows: [this.buildPublicTocRow(doc, this.currentFileOf(doc))] };
    }

    // Admin list count + list
    if (s.startsWith('SELECT COUNT(*)::int AS total FROM document_files df')) {
      return { rows: [{ total: this.filterAdminRows(s, params).length }] };
    }
    if (s.includes('d.title AS document_title') && s.includes('ORDER BY df.uploaded_at DESC')) {
      const rows = this.filterAdminRows(s, params);
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      return {
        rows: rows.slice(offset, offset + limit).map((f) => this.buildAdminTocRow(f)),
      };
    }

    // Admin detail
    if (s.includes('t.auto_payload') && s.includes('WHERE df.id = $1')) {
      const f = this.files.get(String(params[0]));
      return { rows: f ? [this.buildAdminTocRow(f)] : [] };
    }

    // Backfill query
    if (s.includes('COALESCE(t.manual_override, false) AS manual_override') && s.includes('ORDER BY df.created_at ASC')) {
      const standardsOnly = s.includes('d.standard_id IS NOT NULL');
      const allowOutdated = s.includes('t.algorithm_version IS DISTINCT FROM $1');
      const retryFailed = s.includes("t.job_status = 'failed'");
      const currentAlgo = allowOutdated ? String(params[0]) : null;
      const limitMatch = /LIMIT (\d+)/.exec(s);
      const limit = limitMatch ? Number.parseInt(limitMatch[1], 10) : Infinity;

      const matched = [...this.files.values()]
        .filter((f) => {
          if (f.mime_type !== 'application/pdf') return false;
          const doc = this.documents.get(String(f.document_id));
          if (!doc) return false;
          if (standardsOnly && !doc.standard_id) return false;
          const toc = this.tocs.get(String(f.id));
          const isPendingOrMissing = !toc || toc.job_status === 'pending';
          const isOutdated = allowOutdated && toc?.job_status === 'done' && toc.algorithm_version !== currentAlgo;
          const isFailed = retryFailed && toc?.job_status === 'failed';
          return isPendingOrMissing || isOutdated || isFailed;
        })
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
        .slice(0, limit);

      return {
        rows: matched.map((f) => {
          const doc = this.documents.get(String(f.document_id))!;
          const toc = this.tocs.get(String(f.id));
          return {
            file_id: f.id,
            document_id: f.document_id,
            version: f.version,
            storage_path: f.storage_path,
            mime_type: f.mime_type,
            file_size: f.file_size,
            page_count: f.page_count,
            attempts: toc?.attempts ?? 0,
            standard_id: doc.standard_id ?? null,
            manual_override: Boolean(toc?.manual_override),
          };
        }),
      };
    }

    // Standard files list
    if (s.includes('FROM document_files df') && s.includes('WHERE df.document_id = $1')) {
      return {
        rows: this.filesOf(String(params[0])).map((f) => {
          const toc = this.tocs.get(String(f.id));
          return {
            ...f,
            toc_job_status: toc?.job_status ?? null,
            toc_auto_status: toc?.auto_status ?? null,
            toc_manual_override: toc?.manual_override ?? false,
            toc_algorithm_version: toc?.algorithm_version ?? null,
          };
        }),
      };
    }

    // GET /api/documents count + list
    if (s.startsWith('SELECT COUNT(*)::int AS total FROM documents d')) {
      const user = this.userFromVisParams(params);
      const total = [...this.documents.values()].filter((d) =>
        visibleInList(user, d as unknown as DocumentAccessRow)
      ).length;
      return { rows: [{ total }] };
    }
    if (s.includes('FROM documents d') && s.includes('LEFT JOIN document_file_tocs toc')) {
      const user = this.userFromVisParams(params);
      const limit = Number(params[params.length - 2]);
      const offset = Number(params[params.length - 1]);
      const docs = [...this.documents.values()]
        .filter((d) => visibleInList(user, d as unknown as DocumentAccessRow))
        .slice(offset, offset + limit);
      return {
        rows: docs.map((doc) => {
          const f = this.currentFileOf(doc);
          const toc = f ? this.tocs.get(String(f.id)) : undefined;
          return {
            ...doc,
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
            toc_job_status: toc?.job_status ?? null,
            toc_auto_status: toc?.auto_status ?? null,
            toc_manual_override: toc?.manual_override ?? false,
            toc_algorithm_version: toc?.algorithm_version ?? null,
            category_ref_id: null,
            category_name: null,
            tag_names: [],
          };
        }),
      };
    }

    throw new Error(`FakeTocPool: SQL không hỗ trợ: ${s.slice(0, 140)}`);
  }

  async connect() {
    return { query: this.query.bind(this), release: () => undefined };
  }

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

async function buildStructuredPdf(titlePrefix = '1'): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);

  const p1 = doc.addPage([595, 842]);
  p1.drawText('Contents', { x: 60, y: 760, size: 15, font: fontBold });
  p1.drawText(`${titlePrefix}.1 Scope ................................................ 1`, { x: 60, y: 730, size: 11, font: fontReg });
  p1.drawText(`${titlePrefix}.2 Normative references ................................. 2`, { x: 60, y: 710, size: 11, font: fontReg });

  const p2 = doc.addPage([595, 842]);
  p2.drawText(`${titlePrefix}.1 Scope`, { x: 60, y: 760, size: 14, font: fontBold });
  p2.drawText('Detailed scope requirements for the railway engineering standard.', { x: 60, y: 730, size: 11, font: fontReg });
  p2.drawText('1', { x: 60, y: 50, size: 10, font: fontReg });

  const p3 = doc.addPage([595, 842]);
  p3.drawText(`${titlePrefix}.2 Normative references`, { x: 60, y: 760, size: 14, font: fontBold });
  p3.drawText('All normative standards referenced in this clause are indispensable.', { x: 60, y: 730, size: 11, font: fontReg });
  p3.drawText('2', { x: 60, y: 50, size: 10, font: fontReg });

  return Buffer.from(await doc.save());
}

function buildMultipart(fields: Record<string, string>, fileBuf: Buffer, filename = 'std.pdf', mime = 'application/pdf') {
  const boundary = '----elib-toc-test-boundary';
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8')
    );
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      'utf8'
    ),
    fileBuf,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  );
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeSampleAutoPayload(status: TocAutoPayload['status'], flags: string[] = []): TocAutoPayload {
  return {
    schemaVersion: 1,
    algorithmVersion: TOC_ALGORITHM_VERSION,
    status,
    strategy: 'body_headings',
    reason: status === 'partial' ? 'skipped_needs_ocr_pages' : null,
    flags,
    totalPages: 20,
    offset: null,
    needsOcrPages: status === 'partial' ? [12] : [],
    nodes:
      status === 'needs_ocr'
        ? []
        : [
            { title: '1 Phạm vi', level: 1, page_pdf: 3, sort: 1, source: 'body_headings', confidence: 0.9 },
            { title: '2 Viện dẫn', level: 1, page_pdf: 8, sort: 2, source: 'body_headings', confidence: 0.9 },
            { title: '3 Yêu cầu', level: 1, page_pdf: 15, sort: 3, source: 'body_headings', confidence: 0.9 },
          ],
    limitsApplied: { truncatedNodes: 0, truncatedTitles: 0, clampedDepths: 0, exceededAction: 'none' },
    stats: {
      sourceDistribution: { outline: 0, printed_toc: 0, body_headings: status === 'needs_ocr' ? 0 : 3 },
      suspiciousInTreeCount: 0,
      filteredNoiseCount: 0,
      qpdfMs: 0,
      extractMs: 120,
      buildMs: 15,
    },
  };
}

describe('Phase C — Routes đọc/quản trị TOC, phân quyền Phase A, Worker & Backfill', () => {
  let root: string;
  let storage: LocalDiskStorage;
  let pool: FakeTocPool;
  let cfg: AppConfig;
  let app: Awaited<ReturnType<typeof createApp>>;
  let pdfV1: Buffer;
  let pdfV2: Buffer;
  const cookies: Record<keyof typeof USERS, string> = {} as Record<keyof typeof USERS, string>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'elib-toc-routes-'));
    storage = new LocalDiskStorage(root);
    pool = new FakeTocPool();
    cfg = { ...loadConfig(), logLevel: 'silent', storageRoot: root, tocStandardsOnly: true };
    app = await createApp({ pool: pool.asPool(), storage, config: cfg, previewJob: false, codeCheckJob: false, tocJob: false });
    for (const [k, u] of Object.entries(USERS) as Array<[keyof typeof USERS, CurrentUser]>) {
      cookies[k] = `elib_session=${pool.addUser(u)}`;
    }
    pdfV1 = await buildStructuredPdf('1');
    pdfV2 = await buildStructuredPdf('2');
  });

  afterAll(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    pool.reset();
  });

  async function seedDocWithToc(opts: {
    visibility?: string;
    status?: string;
    standardId?: string | null;
    createdBy?: string;
    previewPages?: number | null;
    pageCount?: number | null;
    mimeType?: string;
    toc?: Partial<Row> | null;
  }) {
    const docId = randomUUID();
    const fileId = randomUUID();
    const now = new Date();
    pool.documents.set(docId, {
      id: docId,
      title: 'Tài liệu kiểm thử TOC',
      slug: `doc-${docId.slice(0, 8)}`,
      description: null,
      category_id: null,
      doc_type: null,
      language: 'vi',
      visibility: opts.visibility ?? 'internal',
      status: opts.status ?? 'published',
      price: null,
      standard_id: opts.standardId === undefined ? randomUUID() : opts.standardId,
      current_file_id: fileId,
      created_by: opts.createdBy ?? ADMIN_ID,
      created_at: now,
      updated_at: now,
    });
    pool.files.set(fileId, {
      id: fileId,
      document_id: docId,
      version: 1,
      storage_path: storage.buildOriginalPath(docId, 1, fileId, 'pdf'),
      original_filename: 'sample.pdf',
      mime_type: opts.mimeType ?? 'application/pdf',
      file_size: 1024,
      checksum_sha256: 'hash-' + fileId,
      page_count: opts.pageCount === undefined ? 20 : opts.pageCount,
      preview_pages: opts.previewPages === undefined ? 5 : opts.previewPages,
      preview_status: 'ready',
      version_label: 'v1.0',
      uploaded_by: ADMIN_ID,
      uploaded_at: now,
      created_at: now,
    });
    if (opts.toc !== null) {
      pool.tocs.set(fileId, {
        file_id: fileId,
        job_status: 'done',
        locked_at: null,
        attempts: 1,
        last_error: null,
        auto_status: 'ok',
        auto_strategy: 'body_headings',
        auto_flags: [],
        auto_payload: makeSampleAutoPayload('ok'),
        algorithm_version: TOC_ALGORITHM_VERSION,
        extracted_at: now,
        manual_override: false,
        manual_payload: null,
        manual_updated_by: null,
        manual_updated_at: null,
        ...opts.toc,
      });
    }
    return { docId, fileId };
  }

  it('1. Ma trận quyền đọc Phase A: 404 ẩn danh, 403 external, FULL internal tiêu chuẩn, preview_only + locked cho public/members', async () => {
    const std = await seedDocWithToc({ visibility: 'internal', standardId: randomUUID(), previewPages: 5 });
    const pub = await seedDocWithToc({ visibility: 'public', standardId: null, createdBy: ADMIN_ID, previewPages: 5 });
    const mem = await seedDocWithToc({ visibility: 'members', standardId: null, createdBy: ADMIN_ID, previewPages: 5 });
    const draft = await seedDocWithToc({ visibility: 'public', status: 'draft', standardId: null, createdBy: ADMIN_ID });

    // UUID không hợp lệ -> 404
    const badUuid = await app.inject({ method: 'GET', url: '/api/documents/not-a-uuid/toc' });
    expect(badUuid.statusCode).toBe(404);

    // Ẩn danh trên internal / members / draft -> 404 thống nhất (không lộ tồn tại)
    for (const id of [std.docId, mem.docId, draft.docId]) {
      const r = await app.inject({ method: 'GET', url: `/api/documents/${id}/toc` });
      expect(r.statusCode).toBe(404);
    }

    // Khách ngoài (external) trên tiêu chuẩn internal -> 403
    const extOnStd = await app.inject({
      method: 'GET',
      url: `/api/documents/${std.docId}/toc`,
      headers: { cookie: cookies.extViewer },
    });
    expect(extOnStd.statusCode).toBe(403);

    // Người nội bộ (internal viewer) trên tiêu chuẩn -> 200 FULL + private, no-store
    const intOnStd = await app.inject({
      method: 'GET',
      url: `/api/documents/${std.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(intOnStd.statusCode).toBe(200);
    expect(intOnStd.headers['cache-control']).toBe('private, no-store');
    expect(intOnStd.json().preview_only).toBe(false);
    expect(intOnStd.json().max_accessible_page).toBeNull();
    expect(intOnStd.json().nodes.every((n: { locked: boolean }) => n.locked === false)).toBe(true);

    // Ẩn danh / external trên public -> preview_only=true, nút trang 8 và 15 bị locked=true (> preview_pages=5)
    const anonOnPub = await app.inject({ method: 'GET', url: `/api/documents/${pub.docId}/toc` });
    expect(anonOnPub.statusCode).toBe(200);
    expect(anonOnPub.json().preview_only).toBe(true);
    expect(anonOnPub.json().max_accessible_page).toBe(5);
    expect(anonOnPub.json().nodes.map((n: { locked: boolean }) => n.locked)).toEqual([false, true, true]);

    // External trên members -> preview_only=true + private, no-store
    const extOnMem = await app.inject({
      method: 'GET',
      url: `/api/documents/${mem.docId}/toc`,
      headers: { cookie: cookies.extViewer },
    });
    expect(extOnMem.statusCode).toBe(200);
    expect(extOnMem.headers['cache-control']).toBe('private, no-store');
    expect(extOnMem.json().preview_only).toBe(true);
  });

  it('2. Bảo vệ hai lớp: ẩn partial/needs_ocr/processing/unsupported/not_enabled ở API đọc, Admin vẫn xem đủ', async () => {
    const partial = await seedDocWithToc({
      toc: { auto_status: 'partial', auto_payload: makeSampleAutoPayload('partial', ['outline_incomplete']) },
    });
    const processing = await seedDocWithToc({
      visibility: 'public',
      standardId: null,
      toc: { job_status: 'processing', auto_status: null, auto_payload: null },
    });
    const notEnabled = await seedDocWithToc({ standardId: null, toc: null });
    const nonPdf = await seedDocWithToc({ mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', toc: null });

    const rPartial = await app.inject({
      method: 'GET',
      url: `/api/documents/${partial.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(rPartial.statusCode).toBe(200);
    expect(rPartial.json().displayable).toBe(false);
    expect(rPartial.json().status).toBe('partial');
    expect(rPartial.json().nodes).toEqual([]);

    const rAdminPartial = await app.inject({
      method: 'GET',
      url: `/api/admin/files/${partial.fileId}/toc`,
      headers: { cookie: cookies.admin },
    });
    expect(rAdminPartial.statusCode).toBe(200);
    expect(rAdminPartial.json().auto_payload.nodes).toHaveLength(3);

    const rProc = await app.inject({ method: 'GET', url: `/api/documents/${processing.docId}/toc` });
    expect(rProc.statusCode).toBe(200);
    expect(rProc.headers['cache-control']).toBe('private, no-store');
    expect(rProc.json().state).toBe('processing');
    expect(rProc.json().nodes).toEqual([]);

    const rNotEnabled = await app.inject({
      method: 'GET',
      url: `/api/documents/${notEnabled.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(rNotEnabled.json().state).toBe('not_enabled');

    const rNonPdf = await app.inject({
      method: 'GET',
      url: `/api/documents/${nonPdf.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(rNonPdf.json().state).toBe('unsupported');
  });

  it('3. Upload tiêu chuẩn nhiều phiên bản + job nền + đổi current_file_id + TOC_STANDARDS_ONLY', async () => {
    const mp1 = buildMultipart({ title: 'TCVN 14560:2025', standard_code: 'TCVN 14560:2025', status: 'published', version_label: 'Ban đầu' }, pdfV1, 'v1.pdf');
    const up1 = await app.inject({ method: 'POST', url: '/api/documents', headers: { cookie: cookies.intViewer, 'content-type': mp1.contentType }, payload: mp1.payload });
    expect(up1.statusCode).toBe(201);
    const docId = up1.json().document.id as string;
    const v1Id = up1.json().file.id as string;
    expect(pool.tocs.get(v1Id)?.job_status).toBe('pending');

    // Upload tài liệu thường khi tocStandardsOnly=true -> không xếp hàng TOC
    const mpNormal = buildMultipart({ title: 'Tài liệu thường', visibility: 'public', status: 'published' }, pdfV2, 'normal.pdf');
    const upNormal = await app.inject({ method: 'POST', url: '/api/documents', headers: { cookie: cookies.intEditor, 'content-type': mpNormal.contentType }, payload: mpNormal.payload });
    expect(upNormal.statusCode).toBe(201);
    expect(pool.tocs.has(upNormal.json().file.id)).toBe(false);

    // Chạy worker xử lý v1
    const processed1 = await runTocJobOnce(pool.asPool(), storage, cfg, () => undefined, 1);
    expect(processed1).toBe(1);
    expect(pool.tocs.get(v1Id)?.job_status).toBe('done');

    // Upload phiên bản v2 cho cùng tiêu chuẩn & chạy worker
    const mp2 = buildMultipart({ title: 'TCVN 14560:2025', standard_code: 'TCVN 14560:2025', status: 'published', version_label: 'Sửa đổi 1:2026', force: 'true' }, pdfV2, 'v2.pdf');
    const up2 = await app.inject({ method: 'POST', url: '/api/documents', headers: { cookie: cookies.intViewer, 'content-type': mp2.contentType }, payload: mp2.payload });
    expect(up2.statusCode).toBe(201);
    const v2Id = up2.json().file.id as string;
    await runTocJobOnce(pool.asPool(), storage, cfg, () => undefined, 1);

    // Kiểm tra metadata nhẹ ở GET /api/standards/:code/files và GET /api/documents
    const stdFiles = await app.inject({
      method: 'GET',
      url: '/api/standards/TCVN%2014560%3A2025/files',
      headers: { cookie: cookies.intViewer },
    });
    expect(stdFiles.statusCode).toBe(200);
    expect(stdFiles.json().current_file.id).toBe(v2Id);
    expect(stdFiles.json().current_file.toc_job_status).toBe('done');
    expect(stdFiles.json().current_file.toc_status).toBe('ok');
    expect(stdFiles.json().current_file.toc_has_manual).toBe(false);
    expect(stdFiles.json().current_file.toc_algorithm_version).toBe(TOC_ALGORITHM_VERSION);

    const docsList = await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie: cookies.intViewer } });
    const stdDocInList = docsList.json().data.find((d: { id: string }) => d.id === docId);
    expect(stdDocInList.file.toc_status).toBe('ok');
    expect(stdDocInList.file.toc_algorithm_version).toBe(TOC_ALGORITHM_VERSION);

    // GET /api/documents/:id/toc mặc định trả v2 (titlePrefix '2')
    const curV2 = await app.inject({ method: 'GET', url: `/api/documents/${docId}/toc`, headers: { cookie: cookies.intViewer } });
    expect(curV2.json().file.id).toBe(v2Id);
    expect(curV2.json().nodes.some((n: { title: string }) => n.title.startsWith('2.1'))).toBe(true);

    // Admin đổi current_file_id về v1 -> /toc tự phục vụ cây của v1
    const switchRes = await app.inject({
      method: 'PATCH',
      url: `/api/documents/${docId}/current-version`,
      headers: { cookie: cookies.admin, 'content-type': 'application/json' },
      payload: JSON.stringify({ file_id: v1Id }),
    });
    expect(switchRes.statusCode).toBe(200);
    const curV1 = await app.inject({ method: 'GET', url: `/api/documents/${docId}/toc`, headers: { cookie: cookies.intViewer } });
    expect(curV1.json().file.id).toBe(v1Id);
    expect(curV1.json().nodes.some((n: { title: string }) => n.title.startsWith('1.1'))).toBe(true);

    // Endpoint theo fileId vẫn đọc được v2 riêng biệt
    const specV2 = await app.inject({ method: 'GET', url: `/api/documents/${docId}/files/${v2Id}/toc`, headers: { cookie: cookies.intViewer } });
    expect(specV2.json().file.id).toBe(v2Id);
    expect(specV2.json().nodes.some((n: { title: string }) => n.title.startsWith('2.1'))).toBe(true);

    // Khi cấu hình tocStandardsOnly=false -> upload tài liệu thường cũng xếp hàng TOC
    const pdf3 = await buildStructuredPdf('3');
    const allPdfsApp = await createApp({
      pool: pool.asPool(),
      storage,
      config: { ...cfg, tocStandardsOnly: false },
      previewJob: false,
      codeCheckJob: false,
      tocJob: false,
    });
    try {
      const mpAll = buildMultipart({ title: 'Tài liệu thường bật TOC', visibility: 'public', status: 'published' }, pdf3, 'all-enabled.pdf');
      const upAll = await allPdfsApp.inject({
        method: 'POST',
        url: '/api/documents',
        headers: { cookie: cookies.intEditor, 'content-type': mpAll.contentType },
        payload: mpAll.payload,
      });
      expect(upAll.statusCode).toBe(201);
      expect(pool.tocs.get(upAll.json().file.id)?.job_status).toBe('pending');
    } finally {
      await allPdfsApp.close();
    }
  });

  it('4. Phân quyền Admin (canManageToc), validate thủ công, promote-auto, delete manual & reextract giữ nguyên manual', async () => {
    const partial = await seedDocWithToc({
      pageCount: 15,
      toc: {
        auto_status: 'partial',
        auto_flags: ['outline_incomplete'],
        auto_payload: makeSampleAutoPayload('partial', ['outline_incomplete']),
        algorithm_version: 'pdf-toc-v0.9',
      },
    });
    // Ghi file PDF thật lên đĩa cho đường dẫn reextract/job
    await storage.saveBytes(pdfV1, String(pool.files.get(partial.fileId)!.storage_path));

    // Chặn người không phải admin & chặn must_change_password
    const unauth = await app.inject({ method: 'GET', url: '/api/admin/tocs' });
    expect(unauth.statusCode).toBe(401);
    for (const key of ['intViewer', 'intEditor', 'extEditor'] as const) {
      const forb = await app.inject({
        method: 'GET',
        url: '/api/admin/tocs',
        headers: { cookie: cookies[key] },
      });
      expect(forb.statusCode).toBe(403);
    }
    const mcp = await app.inject({
      method: 'GET',
      url: '/api/admin/tocs',
      headers: { cookie: cookies.mustChangeAdmin },
    });
    expect(mcp.statusCode).toBe(403);
    expect(mcp.json().error.code).toBe('MUST_CHANGE_PASSWORD');

    // Lọc queue admin
    const adminList = await app.inject({
      method: 'GET',
      url: '/api/admin/tocs?auto_status=partial&flag=outline_incomplete&outdated_algorithm=true',
      headers: { cookie: cookies.admin },
    });
    expect(adminList.statusCode).toBe(200);
    expect(adminList.json().total).toBe(1);

    // Promote auto -> cứu cây partial thành bản duyệt tay
    const promoted = await app.inject({
      method: 'POST',
      url: `/api/admin/files/${partial.fileId}/toc/promote-auto`,
      headers: { cookie: cookies.admin, 'content-type': 'application/json' },
      payload: JSON.stringify({ note: 'Đã rà soát bản partial' }),
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().manual_override).toBe(true);

    const readerAfterPromote = await app.inject({
      method: 'GET',
      url: `/api/documents/${partial.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(readerAfterPromote.json().displayable).toBe(true);
    expect(readerAfterPromote.json().effective_source).toBe('manual');
    expect(readerAfterPromote.json().status).toBe('ok');

    // Validate chặt trên PUT manual
    const badPage = await app.inject({
      method: 'PUT',
      url: `/api/admin/files/${partial.fileId}/toc/manual`,
      headers: { cookie: cookies.admin, 'content-type': 'application/json' },
      payload: JSON.stringify({ nodes: [{ title: 'Mục quá trang', level: 1, page_pdf: 99 }] }),
    });
    expect(badPage.statusCode).toBe(400);
    expect(badPage.json().error.code).toBe('INVALID_PAGE_RANGE');

    const badTitle = await app.inject({
      method: 'PUT',
      url: `/api/admin/files/${partial.fileId}/toc/manual`,
      headers: { cookie: cookies.admin, 'content-type': 'application/json' },
      payload: JSON.stringify({ nodes: [{ title: '   ', level: 1, page_pdf: 1 }] }),
    });
    expect(badTitle.statusCode).toBe(400);
    expect(badTitle.json().error.code).toBe('INVALID_TOC_TITLE');

    // PUT manual hợp lệ + chuẩn hóa sort/source/confidence
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/admin/files/${partial.fileId}/toc/manual`,
      headers: { cookie: cookies.admin, 'content-type': 'application/json' },
      payload: JSON.stringify({
        nodes: [
          { title: 'Chương I  Tổng quan', level: 1, page_pdf: 2 },
          { title: 'Mục 1.1\u00A0Phạm vi', level: 2, page_pdf: 3 },
        ],
      }),
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().manual_payload.nodes).toEqual([
      { title: 'Chương I Tổng quan', level: 1, page_pdf: 2, sort: 1, source: 'manual', confidence: 1 },
      { title: 'Mục 1.1 Phạm vi', level: 2, page_pdf: 3, sort: 2, source: 'manual', confidence: 1 },
    ]);

    // Reextract KHÔNG được ghi đè manual_override / manual_payload
    const reext = await app.inject({
      method: 'POST',
      url: `/api/admin/files/${partial.fileId}/toc/reextract`,
      headers: { cookie: cookies.admin },
    });
    expect(reext.statusCode).toBe(200);
    expect(reext.json().manual_override).toBe(true);
    await runTocJobOnce(pool.asPool(), storage, cfg, () => undefined, 1);

    const readerAfterReextract = await app.inject({
      method: 'GET',
      url: `/api/documents/${partial.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(readerAfterReextract.json().effective_source).toBe('manual');
    expect(readerAfterReextract.json().nodes[0].title).toBe('Chương I Tổng quan');
    expect(pool.tocs.get(partial.fileId)?.algorithm_version).toBe(TOC_ALGORITHM_VERSION);

    // Xóa manual override -> quay lại auto mới chạy lại
    const delManual = await app.inject({
      method: 'DELETE',
      url: `/api/admin/files/${partial.fileId}/toc/manual`,
      headers: { cookie: cookies.admin },
    });
    expect(delManual.statusCode).toBe(200);
    const readerAfterDelete = await app.inject({
      method: 'GET',
      url: `/api/documents/${partial.docId}/toc`,
      headers: { cookie: cookies.intViewer },
    });
    expect(readerAfterDelete.json().effective_source).toBe('auto');
    expect(readerAfterDelete.json().nodes.some((n: { title: string }) => n.title.startsWith('1.1'))).toBe(true);

    // Reextract trên file không phải PDF -> 400 TOC_UNSUPPORTED_FORMAT
    const nonPdf = await seedDocWithToc({
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      toc: null,
    });
    const reextNonPdf = await app.inject({
      method: 'POST',
      url: `/api/admin/files/${nonPdf.fileId}/toc/reextract`,
      headers: { cookie: cookies.admin },
    });
    expect(reextNonPdf.statusCode).toBe(400);
    expect(reextNonPdf.json().error.code).toBe('TOC_UNSUPPORTED_FORMAT');
  });

  it('5. Worker (claimSkipLocked, stale timeout, qpdf password unsupported, oversize, page_count) & Backfill', async () => {
    const f1 = await seedDocWithToc({
      pageCount: null,
      toc: { job_status: 'pending', attempts: 0, auto_status: null, auto_payload: null },
    });
    const f2 = await seedDocWithToc({
      pageCount: null,
      toc: { job_status: 'pending', attempts: 0, auto_status: null, auto_payload: null },
    });
    await storage.saveBytes(pdfV1, String(pool.files.get(f1.fileId)!.storage_path));
    await storage.saveBytes(pdfV2, String(pool.files.get(f2.fileId)!.storage_path));

    // Claim nguyên tử 2 file liên tiếp không trùng
    pool.files.get(f1.fileId)!.created_at = new Date(Date.now() - 2000);
    pool.files.get(f2.fileId)!.created_at = new Date(Date.now() - 1000);
    const c1 = await claimNextTocJob(pool.asPool());
    const c2 = await claimNextTocJob(pool.asPool());
    const c3 = await claimNextTocJob(pool.asPool());
    expect([c1?.file_id, c2?.file_id]).toEqual([f1.fileId, f2.fileId]);
    expect(c3).toBeNull();
    expect(c1?.attempts).toBe(1);

    // Giả lập stale lock: f1 attempts=1 -> nhả pending; f2 attempts=2 -> đánh failed
    pool.tocs.get(f1.fileId)!.locked_at = new Date(Date.now() - 30 * 60_000);
    pool.tocs.get(f2.fileId)!.attempts = 2;
    pool.tocs.get(f2.fileId)!.locked_at = new Date(Date.now() - 30 * 60_000);
    const released = await releaseStaleTocJobs(pool.asPool(), 15, 2);
    expect(released).toEqual({ requeued: 1, failed: 1 });
    expect(pool.tocs.get(f1.fileId)!.job_status).toBe('pending');
    expect(pool.tocs.get(f2.fileId)!.job_status).toBe('failed');
    expect(pool.tocs.get(f2.fileId)!.last_error).toBe('toc_job_stale_timeout');

    // Chạy processTocFile cho f1 -> cập nhật page_count=3 từ null
    const claimedF1 = (await claimNextTocJob(pool.asPool()))!;
    const st1 = await processTocFile(pool.asPool(), storage, claimedF1, cfg);
    expect(st1).toBe('ok');
    expect(pool.files.get(f1.fileId)!.page_count).toBe(3);

    // Oversize -> done + unsupported ('file_too_large')
    const smallLimitCfg: AppConfig = { ...cfg, tocMaxFileMb: 0.0001 as unknown as number };
    const oversizeRow: TocJobRow = {
      file_id: f2.fileId,
      document_id: f2.docId,
      version: 1,
      storage_path: String(pool.files.get(f2.fileId)!.storage_path),
      mime_type: 'application/pdf',
      file_size: 500_000,
      page_count: null,
      attempts: 1,
      standard_id: null,
    };
    const stOver = await processTocFile(pool.asPool(), storage, oversizeRow, smallLimitCfg);
    expect(stOver).toBe('unsupported');
    expect(pool.tocs.get(f2.fileId)!.last_error).toBe('file_too_large');

    // PDF mã hóa yêu cầu mật khẩu -> done + unsupported, không sót file tạm
    const enc = await seedDocWithToc({ toc: { job_status: 'pending', attempts: 0, auto_status: null, auto_payload: null } });
    await storage.saveBytes(Buffer.from(makeRc4EncryptedPdf({ pageCount: 3, userPassword: 'pw' })), String(pool.files.get(enc.fileId)!.storage_path));
    const pwRunner: QpdfRunner = async (_bin, args) => ({
      exitCode: 2,
      signal: null,
      stdout: '',
      stderr: `qpdf: ${args[2]}: invalid password`,
    });
    const stEnc = await processTocFile(
      pool.asPool(),
      storage,
      (await claimNextTocJob(pool.asPool()))!,
      cfg,
      () => undefined,
      { qpdfRunner: pwRunner }
    );
    expect(stEnc).toBe('unsupported');
    expect(pool.tocs.get(enc.fileId)!.job_status).toBe('done');
    expect(await readdir(path.join(root, 'tmp'))).toEqual([]);

    // Backfill: tạo 1 file tiêu chuẩn outdated có manual_override=true + 1 file thường chưa có dòng TOC
    const outdatedStd = await seedDocWithToc({
      standardId: randomUUID(),
      toc: {
        job_status: 'done',
        auto_status: 'ok',
        algorithm_version: 'pdf-toc-v0.1',
        manual_override: true,
        manual_payload: { schemaVersion: 1, updatedFromAlgorithmVersion: 'pdf-toc-v0.1', note: null, nodes: [{ title: 'Manual Keep', level: 1, page_pdf: 1, sort: 1, source: 'manual', confidence: 1 }] } satisfies TocManualPayload,
      },
    });
    await storage.saveBytes(pdfV1, String(pool.files.get(outdatedStd.fileId)!.storage_path));
    const normalNoToc = await seedDocWithToc({ standardId: null, toc: null });
    await storage.saveBytes(pdfV2, String(pool.files.get(normalNoToc.fileId)!.storage_path));

    // Dry-run standardsOnly + reextractOutdated -> thấy outdatedStd, bỏ qua normalNoToc
    const dry = await runTocBackfill(pool.asPool(), storage, cfg, {
      rate: 100,
      limit: null,
      dryRun: true,
      standardsOnly: true,
      reextractOutdated: true,
      retryFailed: false,
    });
    expect(dry.skipped).toBe(1);
    expect(dry.manualOverridePreserved).toBe(1);

    // Chạy thật all-pdfs + reextractOutdated -> cập nhật both và KHÔNG đụng manual_override
    const real = await runTocBackfill(pool.asPool(), storage, cfg, {
      rate: 100,
      limit: null,
      dryRun: false,
      standardsOnly: false,
      reextractOutdated: true,
      retryFailed: false,
    });
    expect(real.ok).toBe(2);
    expect(real.manualOverridePreserved).toBe(1);
    expect(pool.tocs.get(outdatedStd.fileId)!.algorithm_version).toBe(TOC_ALGORITHM_VERSION);
    expect(pool.tocs.get(outdatedStd.fileId)!.manual_override).toBe(true);
    expect((pool.tocs.get(outdatedStd.fileId)!.manual_payload as TocManualPayload).nodes[0].title).toBe('Manual Keep');
    expect(pool.tocs.get(normalNoToc.fileId)!.job_status).toBe('done');
  });
});
