import { DataTypes, Model } from 'sequelize';
import sequelize from '../lib/sequelize.js';

class Settings extends Model {}

Settings.init({
  key: {
    type: DataTypes.STRING,
    unique: true,
    primaryKey: true
  },
  value: {
    type: DataTypes.JSONB,
    allowNull: false
  }
}, {
  sequelize,
  modelName: 'Settings',
  timestamps: true
});

export default Settings;
