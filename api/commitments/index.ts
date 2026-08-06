import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  bulkCreateCommitments,
  createCommitment,
  listCommitments,
  type CommitmentInput,
} from '../../src/services/commitments.js';
import { getUserId } from '../_auth.js';

/**
 * GET  /api/commitments?category=&activeOn=  — list (FR-C14 filters).
 * POST /api/commitments                       — create one, or bulk when body is
 *                                                { items: CommitmentInput[] } (FR-C03).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = getUserId(req, res);
  if (!userId) return;

  try {
    if (req.method === 'GET') {
      const category = typeof req.query.category === 'string' ? req.query.category : undefined;
      const activeOn = typeof req.query.activeOn === 'string' ? req.query.activeOn : undefined;
      const rows = await listCommitments(userId, { category: category as CommitmentInput['category'], activeOn });
      return res.status(200).json({ commitments: rows });
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (Array.isArray(body.items)) {
        const result = await bulkCreateCommitments(userId, body.items as CommitmentInput[]);
        return res.status(result.status === 'ok' ? 201 : 422).json(result);
      }
      const result = await createCommitment(userId, body as unknown as CommitmentInput);
      return res.status(result.status === 'ok' ? 201 : 422).json(result);
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('commitments index failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
