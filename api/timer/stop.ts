import type { VercelRequest, VercelResponse } from '@vercel/node';
import { stopTimer } from '../../src/services/timer.js';
import { getUserId } from '../_auth.js';

/**
 * POST /api/timer/stop (SRS §6.4). Commits the running timer to an actual entry.
 * 200 ok · 200 too_short (under 5 min, nothing stored, FR-A05) · 404 no_timer.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  try {
    const result = await stopTimer(userId);
    if (result.status === 'no_timer') return res.status(404).json(result);
    return res.status(200).json(result);
  } catch (err) {
    console.error('stopTimer failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
