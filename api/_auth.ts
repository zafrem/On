import type { VercelRequest, VercelResponse } from '@vercel/node';

/**
 * Resolve the request's user id.
 *
 * TODO(§6.5): replace with real JWT verification — the API should verify the token,
 * extract `userId`, and apply it to every query. Until the auth flow exists, this reads
 * an `x-user-id` header so the endpoints can be exercised. It is NOT secure and must not
 * ship. Responds 401 and returns null when absent.
 */
export function getUserId(req: VercelRequest, res: VercelResponse): string | null {
  const userId = req.headers['x-user-id'];
  if (typeof userId !== 'string' || userId.length === 0) {
    res.status(401).json({ error: 'unauthenticated' });
    return null;
  }
  return userId;
}
