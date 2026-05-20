import AuditLog from '../models/AuditLog.js';

/**
 * Log an admin action to the audit log
 * @param {Object} req - Express request object
 * @param {string} action - Action name (e.g. 'UPDATE_USER')
 * @param {string} targetType - Type of target ('user', 'subscription', 'settings', 'coupon')
 * @param {string|null} targetId - ID of the target object
 * @param {Object} details - Additional structured data
 */
export async function logAction(req, action, targetType, targetId, details = {}) {
  try {
    if (!req.user) return; // Should not happen if guard is used

    await AuditLog.create({
      adminId: req.user.id,
      adminEmail: req.user.email,
      action,
      targetType,
      targetId: targetId ? String(targetId) : null,
      details,
      ip: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress
    });
  } catch (err) {
    console.error('Audit log failed:', err.message);
    // We don't throw here to avoid failing the main request if logging fails
  }
}
