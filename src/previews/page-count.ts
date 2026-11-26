/**
 * Công thức số trang xem trước (hàm thuần, dễ test):
 *   preview = min(max(1, ceil(tổng × PREVIEW_RATIO)), PREVIEW_MAX_PAGES)
 * Mặc định RATIO=0.2, MAX=10 (10 trang -> 2, 2 trang -> 1, 100 trang -> 10).
 *
 * Nếu kết quả >= tổng số trang (vd tài liệu 1 trang) thì KHÔNG có bản xem
 * trước (trả null) — vì bản xem trước sẽ bằng toàn bộ nội dung.
 */

export interface PreviewPageConfig {
  ratio: number;
  maxPages: number;
}

export const DEFAULT_PREVIEW_RATIO = 0.2;
export const DEFAULT_PREVIEW_MAX_PAGES = 10;

/**
 * Đọc cấu hình preview từ env, validate chặt:
 * - PREVIEW_RATIO: số thực trong (0, 1]; sai/thiếu -> mặc định 0.2.
 * - PREVIEW_MAX_PAGES: số nguyên >= 1; sai/thiếu -> mặc định 10.
 * Giá trị sai không bao giờ làm sập tiến trình — luôn rơi về mặc định an toàn.
 */
export function previewPageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewPageConfig {
  const ratioRaw = env.PREVIEW_RATIO;
  let ratio = DEFAULT_PREVIEW_RATIO;
  if (ratioRaw !== undefined && ratioRaw.trim() !== '') {
    const parsed = Number.parseFloat(ratioRaw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1) {
      ratio = parsed;
    }
  }

  const maxRaw = env.PREVIEW_MAX_PAGES;
  let maxPages = DEFAULT_PREVIEW_MAX_PAGES;
  if (maxRaw !== undefined && maxRaw.trim() !== '') {
    const parsed = Number.parseInt(maxRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      maxPages = parsed;
    }
  }

  return { ratio, maxPages };
}

/**
 * Tính số trang xem trước cho tài liệu có `totalPages` trang.
 * Trả null khi không được xem trước (tổng <= 0, hoặc số trang tính ra
 * bao phủ toàn bộ tài liệu).
 */
export function computePreviewPages(
  totalPages: number,
  cfg: PreviewPageConfig = { ratio: DEFAULT_PREVIEW_RATIO, maxPages: DEFAULT_PREVIEW_MAX_PAGES }
): number | null {
  if (!Number.isFinite(totalPages) || totalPages <= 0) return null;
  const ratio = cfg.ratio > 0 && cfg.ratio <= 1 ? cfg.ratio : DEFAULT_PREVIEW_RATIO;
  const maxPages = cfg.maxPages >= 1 ? Math.floor(cfg.maxPages) : DEFAULT_PREVIEW_MAX_PAGES;
  const pages = Math.min(Math.max(1, Math.ceil(totalPages * ratio)), maxPages);
  if (pages >= totalPages) return null;
  return pages;
}
