import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import { AppError, badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { generateTemporaryPassword, hashPassword } from '../auth/password.js';
import { deleteAllSessions, type CurrentUser, type UserRole, type UserStatus, type UserType } from '../auth/session.js';
import { clearLoginAttemptsForIdentifiers } from '../auth/login-attempts.js';
import { getCurrentUser } from './auth.js';

interface AdminUserRow {
  id: string;
  username: string | null;
  email: string;
  role: UserRole;
  display_name: string | null;
  full_name: string | null;
  organization: string | null;
  status: UserStatus;
  user_type: UserType | null;
  must_change_password: boolean;
  reject_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const ADMIN_USER_COLUMNS =
  'id, username, email, role, display_name, full_name, organization, status, user_type, must_change_password, reject_reason, created_at, updated_at';

const listQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'rejected', 'disabled']).default('pending')
});

const approveSchema = z.object({
  user_type: z.enum(['internal', 'external'])
});

const rejectSchema = z.object({
  reason: z.string().trim().min(1).max(500)
});

const bulkRejectSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().trim().min(1).max(500)
});

const patchSchema = z.object({
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
  user_type: z.enum(['internal', 'external']).optional(),
  status: z.enum(['pending', 'active', 'rejected', 'disabled']).optional()
});

function mapAdminUser(row: AdminUserRow, cfg: AppConfig) {
  const domain = row.email.split('@')[1]?.toLowerCase() ?? '';
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    display_name: row.display_name,
    full_name: row.full_name,
    organization: row.organization,
    status: row.status,
    user_type: row.user_type,
    must_change_password: row.must_change_password === true,
    reject_reason: row.reject_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Gợi ý cho trang duyệt: email thuộc tên miền công ty (chỉ gợi ý, không tự duyệt).
    email_domain_internal: domain.length > 0 && cfg.internalEmailDomains.includes(domain)
  };
}

async function requireAdmin(
  pool: pg.Pool,
  request: FastifyRequest
): Promise<CurrentUser> {
  const user = await getCurrentUser(pool, request.cookies);
  if (!user) throw unauthorized();
  if (user.role !== 'admin') throw forbidden('Chỉ quản trị viên mới thực hiện được thao tác này');
  return user;
}

async function loadUser(pool: pg.Pool, id: string): Promise<AdminUserRow> {
  if (!z.string().uuid().safeParse(id).success) throw notFound('Không tìm thấy người dùng');
  const result = await pool.query(`SELECT ${ADMIN_USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = result.rows[0] as AdminUserRow | undefined;
  if (!row) throw notFound('Không tìm thấy người dùng');
  return row;
}

async function countOtherActiveAdmins(pool: pg.Pool, excludeId: string): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*)::int AS total FROM users WHERE role = 'admin' AND status = 'active' AND id <> $1",
    [excludeId]
  );
  return (result.rows[0] as { total: number }).total;
}

/**
 * API quản trị người dùng (chỉ admin):
 * - GET    /api/admin/users?status=pending   — liệt kê theo trạng thái + số chờ duyệt
 * - POST   /api/admin/users/:id/approve      — duyệt pending (bắt buộc chọn user_type)
 * - POST   /api/admin/users/:id/reject       — từ chối pending (kèm lý do nội bộ)
 * - POST   /api/admin/users/bulk-reject      — từ chối hàng loạt theo danh sách id
 * - PATCH  /api/admin/users/:id              — đổi role/user_type/status (có rào chắn)
 * - POST   /api/admin/users/:id/reset-password — mật khẩu tạm (hiện 1 lần, bắt đổi khi đăng nhập)
 * - POST   /api/admin/users/:id/unlock       — mở khóa đăng nhập
 * Mọi thao tác đều ghi audit log (không ghi mật khẩu).
 */
export function registerAdminUserRoutes(app: FastifyInstance, pool: pg.Pool, cfg: AppConfig): void {
  app.get('/api/admin/users', async (request, reply) => {
    await requireAdmin(pool, request);
    const parsed = listQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_QUERY', 'Tham số status không hợp lệ.');
    }
    const result = await pool.query(
      `SELECT ${ADMIN_USER_COLUMNS} FROM users WHERE status = $1 ORDER BY created_at ASC LIMIT 200`,
      [parsed.data.status]
    );
    const pendingRes = await pool.query(
      "SELECT COUNT(*)::int AS total FROM users WHERE status = 'pending'"
    );
    return reply.send({
      users: (result.rows as AdminUserRow[]).map((row) => mapAdminUser(row, cfg)),
      pendingCount: (pendingRes.rows[0] as { total: number }).total
    });
  });

  app.post('/api/admin/users/:id/approve', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const { id } = request.params as { id: string };
    const parsed = approveSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_USER_TYPE', 'Phải chọn loại người dùng (internal hoặc external) khi duyệt.');
    }
    const target = await loadUser(pool, id);
    if (target.status !== 'pending') {
      throw new AppError(409, 'NOT_PENDING', 'Chỉ duyệt được tài khoản đang chờ duyệt.');
    }
    const updated = await pool.query(
      `UPDATE users SET status = 'active', user_type = $2, updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING ${ADMIN_USER_COLUMNS}`,
      [id, parsed.data.user_type]
    );
    const row = updated.rows[0] as AdminUserRow | undefined;
    if (!row) throw new AppError(409, 'NOT_PENDING', 'Chỉ duyệt được tài khoản đang chờ duyệt.');
    request.log.info(
      { audit: 'user_approved', adminId: admin.id, userId: id, userType: parsed.data.user_type },
      'user approved'
    );
    return reply.send({ user: mapAdminUser(row, cfg) });
  });

  app.post('/api/admin/users/:id/reject', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const { id } = request.params as { id: string };
    const parsed = rejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_REJECT_REASON', 'Phải ghi lý do từ chối (nội bộ).');
    }
    const target = await loadUser(pool, id);
    if (target.status !== 'pending') {
      throw new AppError(409, 'NOT_PENDING', 'Chỉ từ chối được tài khoản đang chờ duyệt.');
    }
    await pool.query(
      `UPDATE users SET status = 'rejected', reject_reason = $2, updated_at = now()
       WHERE id = $1 AND status = 'pending'`,
      [id, parsed.data.reason]
    );
    request.log.info(
      { audit: 'user_rejected', adminId: admin.id, userId: id },
      'user rejected'
    );
    return reply.send({ ok: true });
  });

  app.post('/api/admin/users/bulk-reject', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const parsed = bulkRejectSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('INVALID_INPUT', 'Danh sách id hoặc lý do từ chối không hợp lệ.');
    }
    let rejected = 0;
    for (const id of parsed.data.ids) {
      const updated = await pool.query(
        `UPDATE users SET status = 'rejected', reject_reason = $2, updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [id, parsed.data.reason]
      );
      if (updated.rows.length > 0) rejected++;
    }
    request.log.info(
      { audit: 'user_bulk_rejected', adminId: admin.id, userIds: parsed.data.ids, rejected },
      'users bulk rejected'
    );
    return reply.send({ ok: true, rejected });
  });

  app.patch('/api/admin/users/:id', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const { id } = request.params as { id: string };
    const parsed = patchSchema.safeParse(request.body ?? {});
    if (!parsed.success || (parsed.data.role === undefined && parsed.data.user_type === undefined && parsed.data.status === undefined)) {
      throw badRequest('INVALID_INPUT', 'Dữ liệu cập nhật không hợp lệ.');
    }
    const target = await loadUser(pool, id);
    const nextRole = parsed.data.role ?? target.role;
    const nextUserType = parsed.data.user_type ?? target.user_type;
    const nextStatus = parsed.data.status ?? target.status;

    // Chỉ kích hoạt qua approve (kèm user_type); từ chối qua reject.
    if (parsed.data.status !== undefined && parsed.data.status !== 'active' && parsed.data.status !== 'disabled') {
      throw badRequest('INVALID_STATUS_TRANSITION', 'PATCH chỉ đổi trạng thái sang active/disabled; duyệt dùng approve, từ chối dùng reject.');
    }
    if (target.status === 'pending' && nextStatus === 'active') {
      throw badRequest('INVALID_STATUS_TRANSITION', 'Tài khoản đang chờ duyệt phải được duyệt qua approve kèm loại người dùng.');
    }
    if (target.status === 'rejected' && nextStatus === 'active') {
      throw badRequest('INVALID_STATUS_TRANSITION', 'Tài khoản đã bị từ chối không kích hoạt lại qua PATCH được.');
    }
    // Admin không tự vô hiệu hóa/hạ role chính mình.
    if (admin.id === id && (nextStatus === 'disabled' || nextRole !== target.role)) {
      throw badRequest('CANNOT_MODIFY_SELF', 'Không thể tự vô hiệu hóa hoặc thay đổi role của chính mình.');
    }
    // Không động vào admin active cuối cùng.
    if (
      target.role === 'admin' &&
      target.status === 'active' &&
      (nextRole !== 'admin' || nextStatus === 'disabled') &&
      (await countOtherActiveAdmins(pool, id)) === 0
    ) {
      throw badRequest('LAST_ADMIN', 'Không thể vô hiệu hóa hoặc hạ role của quản trị viên cuối cùng.');
    }
    // Role editor chỉ dành cho người nội bộ.
    if (nextRole === 'editor' && nextUserType !== 'internal') {
      throw badRequest('EDITOR_REQUIRES_INTERNAL', 'Chỉ gán role editor cho người dùng nội bộ (user_type=internal).');
    }

    const updated = await pool.query(
      `UPDATE users SET role = $2, user_type = $3, status = $4, updated_at = now()
       WHERE id = $1
       RETURNING ${ADMIN_USER_COLUMNS}`,
      [id, nextRole, nextUserType, nextStatus]
    );
    const row = updated.rows[0] as AdminUserRow;
    if (nextStatus === 'disabled' && target.status !== 'disabled') {
      await deleteAllSessions(pool, id);
    }
    request.log.info(
      {
        audit: 'user_updated',
        adminId: admin.id,
        userId: id,
        oldRole: target.role,
        newRole: nextRole,
        oldUserType: target.user_type,
        newUserType: nextUserType,
        oldStatus: target.status,
        newStatus: nextStatus
      },
      'user updated by admin'
    );
    return reply.send({ user: mapAdminUser(row, cfg) });
  });

  app.post('/api/admin/users/:id/reset-password', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const { id } = request.params as { id: string };
    await loadUser(pool, id);
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2',
      [passwordHash, id]
    );
    await deleteAllSessions(pool, id);
    // Audit KHÔNG ghi mật khẩu tạm.
    request.log.info(
      { audit: 'user_password_reset', adminId: admin.id, userId: id },
      'user password reset by admin'
    );
    return reply.send({ temporaryPassword });
  });

  app.post('/api/admin/users/:id/unlock', async (request, reply) => {
    const admin = await requireAdmin(pool, request);
    const { id } = request.params as { id: string };
    const target = await loadUser(pool, id);
    await clearLoginAttemptsForIdentifiers(pool, [target.email, target.username ?? '']);
    request.log.info({ audit: 'user_unlocked', adminId: admin.id, userId: id }, 'user login unlocked');
    return reply.send({ ok: true });
  });
}
