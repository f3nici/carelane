import { ApiError } from './errorHandler.js'
import { loadPortalContext } from '../services/portalService.js'

/**
 * Require an authenticated client-portal session. A portal session is identified
 * solely by `req.session.portalClientId` (never a staff `userId`), so this guard
 * and the staff `requireAuth` are mutually exclusive — a staff cookie can't pass
 * here and a portal cookie can't pass the staff stack.
 *
 * The account + participant are re-read on every request (via
 * {@link loadPortalContext}) so a deactivation or a soft-deleted participant
 * takes effect immediately, and the session is torn down when it does. On
 * success `req.portal` carries the account id, client id and a short participant
 * label.
 */
export function requirePortalAuth (req, res, next) {
  const clientId = req.session?.portalClientId
  if (!clientId) return next(new ApiError(401, 'UNAUTHENTICATED', 'You are not signed in. Please log in.'))
  const context = loadPortalContext(clientId)
  if (!context) {
    return req.session.destroy(() => next(new ApiError(401, 'UNAUTHENTICATED', 'You are not signed in. Please log in.')))
  }
  req.portal = context
  next()
}
