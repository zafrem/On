import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getDay } from '../../src/services/getDay.js';
import { getUserId } from '../_auth.js';

/** GET /api/days/{date} — the aggregate day read (SRS §6.4). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  const date = String(req.query.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid_date' });

  try {
    const day = await getDay(userId, date);
    return res.status(200).json(day);
  } catch (err) {
    console.error('getDay failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
