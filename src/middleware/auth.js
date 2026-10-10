import jwt from 'jsonwebtoken';
import User from '../models/User.js';

let defaultUserCache = null;

export const getDefaultUser = async () => {
  if (defaultUserCache) return defaultUserCache;
  let user = await User.findOne({ order: [['createdAt', 'ASC']] });
  if (!user) {
    user = await User.create({
      name: 'Trader',
      email: 'trader@local.dev',
      role: 'user',
      authProvider: 'local'
    });
  }
  defaultUserCache = user;
  return user;
};

export const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.split(' ')[1];
      if (token && token !== 'local-token') {
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
          const user = await User.findByPk(decoded.id, {
            attributes: { exclude: ['password'] }
          });
          if (user) {
            req.user = user;
            return next();
          }
        } catch (e) {
          // Token expired or invalid, continue to fallback
        }
      }
    }
    req.user = await getDefaultUser();
    next();
  } catch (err) {
    try {
      req.user = await getDefaultUser();
      next();
    } catch (e) {
      next(e);
    }
  }
};

export const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET || 'secret', {
    expiresIn: process.env.JWT_EXPIRES_IN || '365d',
  });
