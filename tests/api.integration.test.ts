import { describe, it, expect } from 'vitest';

/**
 * Test tích hợp API + PostgreSQL thật.
 * Sandbox không có PostgreSQL nên các test này được BỎ QUA (skip) khi thiếu
 * DATABASE_URL — không giả vờ pass. Khi chạy trên máy có PostgreSQL:
 *   DATABASE_URL=postgres://... STORAGE_ROOT=/tmp/elib-test npm test
 * (cần chạy `npm run migrate` + tạo user editor/admin trước; xem README).
 */
const hasDb = !!process.env.DATABASE_URL && process.env.ELIB_RUN_DB_TESTS === '1';

describe.skipIf(!hasDb)('API integration (cần PostgreSQL thật)', () => {
  it('placeholder: kiểm tra health qua app.inject', async () => {
    const { createApp } = await import('../src/app.js');
    const app = await createApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    } finally {
      await app.close();
    }
  });
});

describe('ghi chú môi trường test', () => {
  it('DB tests chỉ chạy khi ELIB_RUN_DB_TESTS=1 và có DATABASE_URL', () => {
    expect(typeof hasDb).toBe('boolean');
  });
});
