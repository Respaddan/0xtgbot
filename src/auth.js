import { config } from './config.js';

export function isOwner(userId) {
  return config.ownerId != null && Number(userId) === config.ownerId;
}

export function isAuthorized(userId) {
  if (userId == null) return false;
  const id = Number(userId);
  return isOwner(id) || config.allowedUserIds.includes(id);
}

/**
 * Middleware Telegraf: descarta SIN responder cualquier update de quien no esté
 * autorizado. Para un tercero el bot se ve completamente inerte (no confirma
 * que exista, ni qué hace), aunque conozca el @usuario o le haga ing. inversa.
 */
export function authMiddleware() {
  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!isAuthorized(userId)) {
      // Silencio total: no reply, no answerCbQuery, no logs con datos del intruso.
      return;
    }
    return next();
  };
}
