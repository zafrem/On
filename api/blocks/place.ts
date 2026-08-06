import type { VercelRequest, VercelResponse } from '@vercel/node';
import { placeBlock, type PlaceBlockInput } from '../../src/services/placeBlock.js';
import { getUserId } from '../_auth.js';

/**
 * POST /api/blocks/place — placement. The server computes the push-down chain and
 * commits one transaction (SRS §5.4, §6.4).
 *
 * Body: { taskId, date, startMin, durationMin, id?, expectedVersion? }
 * Responses:
 *   200 ok                 { status:'ok', blockId, version, movedCount, unplacedCount }
 *   409 version_conflict   { status:'conflict', currentVersion }
 *   409 important_limit    { status:'important_limit', date }   → client shows swap dialog
 *   422 rejected           { status:'rejected', reason }        → OUT_OF_DAY | COMMITMENT_OVERLAP
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  const body = (req.body ?? {}) as Partial<PlaceBlockInput>;
  const { taskId, date, startMin, durationMin } = body;
  if (
    typeof taskId !== 'string' ||
    typeof date !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    typeof startMin !== 'number' ||
    typeof durationMin !== 'number'
  ) {
    return res.status(400).json({ error: 'invalid_body' });
  }

  try {
    const result = await placeBlock(userId, {
      taskId,
      date,
      startMin,
      durationMin,
      id: typeof body.id === 'string' ? body.id : undefined,
      expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
    });

    switch (result.status) {
      case 'ok':
        return res.status(200).json(result);
      case 'conflict':
      case 'important_limit':
        return res.status(409).json(result);
      case 'rejected':
        return res.status(422).json(result);
    }
  } catch (err) {
    console.error('placeBlock failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
