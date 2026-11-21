/** Sinh slug từ tiêu đề: bỏ dấu tiếng Việt, chữ thường, gạch nối. */
export function slugify(title: string): string {
  const normalized = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized.length > 0 ? normalized.slice(0, 180) : 'tai-lieu';
}
