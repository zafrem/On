import type { VercelRequest, VercelResponse } from '@vercel/node';
import { startTimer } from '../../src/services/timer.js';
import { getUserId } from '../_auth.js';

/**
 * POST /api/timer/start (SRS §6.4). Body: { deviceId, taskId?, commitmentId?, label?, expectedEndAt? }
 * Auto-commits any running timer (FR-A03). 422 when a label is required but missing.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.deviceId !== 'string' || body.deviceId === '') {
    return res.status(400).json({ error: 'invalid_body', detail: 'deviceId required' });
  }

  try {
    const result = await startTimer(userId, {
      deviceId: body.deviceId,
      taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
      commitmentId: typeof body.commitmentId === 'string' ? body.commitmentId : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      expectedEndAt: typeof body.expectedEndAt === 'string' ? body.expectedEndAt : undefined,
    });
    if (result.status === 'label_required') return res.status(422).json(result);
    return res.status(200).json(result);
  } catch (err) {
    console.error('startTimer failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
