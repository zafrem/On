import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deleteCommitment, updateCommitment, type CommitmentInput } from '../../../src/services/commitments.js';
import { getUserId } from '../../_auth.js';

/** PATCH /api/commitments/{id} — edit. DELETE /api/commitments/{id} — soft-delete (FR-C01). */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = getUserId(req, res);
  if (!userId) return;

  const id = String(req.query.id ?? '');
  if (!id) return res.status(400).json({ error: 'invalid_id' });

  try {
    if (req.method === 'PATCH') {
      const result = await updateCommitment(userId, id, (req.body ?? {}) as Partial<CommitmentInput>);
      const code = result.status === 'ok' ? 200 : result.status === 'not_found' ? 404 : 422;
      return res.status(code).json(result);
    }
    if (req.method === 'DELETE') {
      const result = await deleteCommitment(userId, id);
      return res.status(result.status === 'ok' ? 200 : 404).json(result);
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('commitment [id] failed', err);
    return res.status(500).json({ error: 'internal' });
  }
}
