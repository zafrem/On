import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createTask, listTasks } from '../../src/services/tasks.js';
import { getUserId } from '../_auth.js';

/** GET /api/tasks — list. POST /api/tasks — create (SRS §5.1). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = getUserId(req, res);
  if (!userId) return;

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ tasks: await listTasks(userId) });
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 120) {
        return res.status(400).json({ error: 'invalid_body', detail: 'title 1-120 chars' });
      }
      const result = await createTask(userId, {
        id: typeof body.id === 'string' ? body.id : undefined,
        title: body.title,
        note: typeof body.note === 'string' ? body.note : undefined,
        parentId: typeof body.parentId === 'string' ? body.parentId : undefined,
        kind: body.kind as 'NORMAL' | 'IMPORTANT' | 'SLACK' | undefined,
        estimateMin: typeof body.estimateMin === 'number' ? body.estimateMin : undefined,
        sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
      });
      return res.status(result.status === 'ok' ? 201 : 422).json(result);
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('tasks index failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
