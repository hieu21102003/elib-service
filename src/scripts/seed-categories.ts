import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

/**
 * Dữ liệu danh mục MẪU (seed tạm) — người dùng sẽ cung cấp danh sách thật sau.
 * Chạy nhiều lần vẫn an toàn (idempotent): chỉ chèn khi chưa tồn tại.
 * Nguồn mẫu: 6 nhóm CAT01-CAT06 trong đặc tả Smart.Rail + danh mục con của CAT01.
 */
const SAMPLE: Array<{ name: string; children?: string[] }> = [
  {
    name: 'Hạ tầng đường sắt',
    children: ['Thiết kế hạ tầng', 'Xây dựng và thi công', 'Bảo trì và quản lý tài sản', 'An toàn đường sắt', 'Công trình đặc biệt']
  },
  { name: 'Hệ thống đường sắt' },
  { name: 'Công nghệ số' },
  { name: 'Quy hoạch giao thông' },
  { name: 'Tiêu chuẩn & Quy chuẩn' },
  { name: 'Nghiên cứu & Phát triển' }
];

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);

async function ensureCategory(name: string, parentId: string | null): Promise<string> {
  const found = await pool.query(
    `SELECT id FROM categories
     WHERE lower(name) = lower($1) AND COALESCE(parent_id::text,'') = COALESCE($2::text,'')`,
    [name, parentId]
  );
  if (found.rows.length > 0) return found.rows[0].id as string;
  const inserted = await pool.query(
    'INSERT INTO categories (name, parent_id) VALUES ($1,$2) RETURNING id',
    [name, parentId]
  );
  console.log(`+ danh mục: ${name}`);
  return inserted.rows[0].id as string;
}

try {
  for (const group of SAMPLE) {
    const parentId = await ensureCategory(group.name, null);
    for (const child of group.children ?? []) {
      await ensureCategory(child, parentId);
    }
  }
  console.log('Seed danh mục mẫu hoàn tất (dữ liệu mẫu — sẽ thay bằng danh sách thật).');
} finally {
  await pool.end();
}
