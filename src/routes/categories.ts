import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

interface CategoryRow {
  id: string;
  parent_id: string | null;
  name: string;
}

export interface CategoryNode extends CategoryRow {
  children: CategoryNode[];
}

export function buildCategoryTree(rows: CategoryRow[]): CategoryNode[] {
  const byId = new Map<string, CategoryNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function registerCategoryRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/api/categories', async (_request, reply) => {
    const result = await pool.query(
      'SELECT id, parent_id, name FROM categories ORDER BY name ASC'
    );
    const rows = result.rows as CategoryRow[];
    return reply.send({ data: buildCategoryTree(rows), flat: rows });
  });
}
