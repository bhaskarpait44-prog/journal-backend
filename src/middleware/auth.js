import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ message: 'Not authorized. No token.' });
    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findByPk(decoded.id, {
      attributes: { exclude: ['password'] }
    });
    if (!user) return res.status(401).json({ message: 'User not found.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Token invalid or expired.' });
  }
};

export const generateToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
