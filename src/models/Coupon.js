import { DataTypes, Model } from 'sequelize';
import sequelize from '../lib/sequelize.js';

class Coupon extends Model {}

Coupon.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  code: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    set(value) {
      this.setDataValue('code', value.toUpperCase());
    }
  },
  discountPct: {
    type: DataTypes.INTEGER,
    allowNull: false,
    validate: {
      min: 1,
      max: 100
    }
  },
  maxUses: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  usedCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  },
  validPlans: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: ['starter', 'pro']
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true
  },
  active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true
  }
}, {
  sequelize,
  modelName: 'Coupon',
  timestamps: true
});

export default Coupon;
