import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getTimer } from '../../src/services/timer.js';
import { getUserId } from '../_auth.js';

/** GET /api/timer (SRS §6.4) — read the active timer, or null when none is running. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  try {
    const timer = await getTimer(userId);
    return res.status(200).json({ timer });
  } catch (err) {
    console.error('getTimer failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
