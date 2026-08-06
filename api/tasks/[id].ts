import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deleteTask, updateTask } from '../../src/services/tasks.js';
import { getUserId } from '../_auth.js';

/** PATCH /api/tasks/{id} — edit. DELETE /api/tasks/{id} — soft-delete (SRS §5.1). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = getUserId(req, res);
  if (!userId) return;

  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'invalid_id' });

  try {
    if (req.method === 'PATCH') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await updateTask(userId, {
        id,
        title: typeof body.title === 'string' ? body.title : undefined,
        note: body.note === null || typeof body.note === 'string' ? (body.note as string | null) : undefined,
        estimateMin: typeof body.estimateMin === 'number' ? body.estimateMin : undefined,
        kind: body.kind as 'NORMAL' | 'IMPORTANT' | 'SLACK' | undefined,
        status: body.status as 'TODO' | 'IN_PROGRESS' | 'DONE' | 'ARCHIVED' | undefined,
        sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
      });
      const code =
        result.status === 'ok'
          ? 200
          : result.status === 'not_found'
            ? 404
            : result.status === 'important_conflict'
              ? 409
              : 422;
      return res.status(code).json(result);
    }
    if (req.method === 'DELETE') {
      const result = await deleteTask(userId, id);
      return res.status(result.status === 'ok' ? 200 : 404).json(result);
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('task [id] failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
