import { DataTypes, Model } from 'sequelize';
import sequelize from '../lib/sequelize.js';

class AuditLog extends Model {}

AuditLog.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  adminId: {
    type: DataTypes.UUID,
    allowNull: false
  },
  adminEmail: {
    type: DataTypes.STRING,
    allowNull: false
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false
  },
  targetType: {
    type: DataTypes.ENUM('user', 'subscription', 'settings', 'coupon'),
    allowNull: false
  },
  targetId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  details: {
    type: DataTypes.JSONB,
    defaultValue: {}
  },
  ip: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  sequelize,
  modelName: 'AuditLog',
  timestamps: true,
  updatedAt: false // Only createdAt is needed for logs
});

export default AuditLog;
