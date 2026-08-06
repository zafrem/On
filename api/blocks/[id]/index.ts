import type { VercelRequest, VercelResponse } from '@vercel/node';
import { unplaceBlock } from '../../../src/services/unplaceBlock.js';
import { getUserId } from '../../_auth.js';

/**
 * DELETE /api/blocks/{id} — unplace to the unplaced zone (R-05, FR-U01).
 * Optional ?expectedVersion=N for optimistic concurrency (FR-Y05).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'method_not_allowed' });

  const userId = getUserId(req, res);
  if (!userId) return;

  const blockId = String(req.query.id ?? '');
  if (!blockId) return res.status(400).json({ error: 'invalid_id' });
  const ev = req.query.expectedVersion;
  const expectedVersion = typeof ev === 'string' && ev !== '' ? Number(ev) : undefined;

  try {
    const result = await unplaceBlock(userId, { blockId, expectedVersion });
    switch (result.status) {
      case 'ok':
        return res.status(200).json(result);
      case 'not_found':
        return res.status(404).json(result);
      case 'conflict':
        return res.status(409).json(result);
    }
  } catch (err) {
    console.error('unplaceBlock failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
