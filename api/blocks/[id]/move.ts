import type { VercelRequest, VercelResponse } from '@vercel/node';
import { moveBlock } from '../../../src/services/moveBlock.js';
import { getUserId } from '../../_auth.js';

/**
 * POST /api/blocks/{id}/move — move/resize a block (FR-P05), re-running push-down.
 * Body: { startMin, durationMin, date?, expectedVersion? }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  const blockId = String(req.query.id ?? '');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { startMin, durationMin } = body;
  if (!blockId || typeof startMin !== 'number' || typeof durationMin !== 'number') {
    return res.status(400).json({ error: 'invalid_body' });
  }
  const date = typeof body.date === 'string' ? body.date : undefined;
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'invalid_date' });

  try {
    const result = await moveBlock(userId, {
      blockId,
      startMin,
      durationMin,
      date,
      expectedVersion: typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined,
    });

    switch (result.status) {
      case 'ok':
        return res.status(200).json(result);
      case 'not_found':
        return res.status(404).json(result);
      case 'conflict':
      case 'important_limit':
        return res.status(409).json(result);
      case 'rejected':
        return res.status(422).json(result);
    }
  } catch (err) {
    console.error('moveBlock failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
