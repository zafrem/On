import type { VercelRequest, VercelResponse } from '@vercel/node';
import { cancelInstance, rescheduleInstance } from '../../../src/services/commitments.js';
import { getUserId } from '../../_auth.js';

/**
 * POST /api/commitments/{id}/exceptions — cancel or reschedule a single occurrence (FR-C04).
 * Body: { date, type: 'CANCELLED' } or { date, type: 'MODIFIED', startMin, durationMin }.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  const commitmentId = String(req.query.id ?? '');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const date = typeof body.date === 'string' ? body.date : '';
  if (!commitmentId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'invalid_body', detail: 'commitment id and date required' });
  }

  try {
    let result: { status: 'ok' | 'not_found' };
    if (body.type === 'CANCELLED') {
      result = await cancelInstance(userId, commitmentId, date);
    } else if (body.type === 'MODIFIED') {
      if (typeof body.startMin !== 'number' || typeof body.durationMin !== 'number') {
        return res.status(400).json({ error: 'invalid_body', detail: 'MODIFIED needs startMin & durationMin' });
      }
      result = await rescheduleInstance(userId, commitmentId, date, body.startMin, body.durationMin);
    } else {
      return res.status(400).json({ error: 'invalid_body', detail: 'type must be CANCELLED or MODIFIED' });
    }
    return res.status(result.status === 'ok' ? 200 : 404).json(result);
  } catch (err) {
    console.error('commitment exceptions failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
