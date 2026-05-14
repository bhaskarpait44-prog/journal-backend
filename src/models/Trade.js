import { DataTypes, Model } from 'sequelize';
import sequelize from '../lib/sequelize.js';
import User from './User.js';

class Trade extends Model {}

Trade.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: false,
    references: {
      model: User,
      key: 'id'
    }
  },
  symbol: {
    type: DataTypes.STRING,
    allowNull: false
  },
  underlying: {
    type: DataTypes.STRING,
    allowNull: false
  },
  tradeType: {
    type: DataTypes.ENUM('BUY', 'SELL'),
    allowNull: false
  },
  optionType: {
    type: DataTypes.ENUM('CE', 'PE'),
    allowNull: false
  },
  strikePrice: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  expiryDate: {
    type: DataTypes.DATE,
    allowNull: false
  },
  lotSize: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  entryPrice: {
    type: DataTypes.FLOAT,
    allowNull: false
  },
  exitPrice: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  stopLoss: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  target: {
    type: DataTypes.FLOAT,
    allowNull: true
  },
  entryDate: {
    type: DataTypes.DATE,
    allowNull: false
  },
  exitDate: {
    type: DataTypes.DATE,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM('OPEN', 'CLOSED', 'EXPIRED'),
    defaultValue: 'OPEN'
  },
  pnl: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  pnlPercent: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  charges: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  netPnl: {
    type: DataTypes.FLOAT,
    defaultValue: 0
  },
  strategy: {
    type: DataTypes.STRING,
    allowNull: true
  },
  setupType: {
    type: DataTypes.STRING,
    allowNull: true
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  tags: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  rating: {
    type: DataTypes.INTEGER,
    validate: { min: 1, max: 5 }
  },
  source: {
    type: DataTypes.ENUM('manual', 'csv', 'broker_api'),
    defaultValue: 'manual'
  },
  brokerId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  broker: {
    type: DataTypes.STRING,
    allowNull: true
  },
  exchange: {
    type: DataTypes.ENUM('NSE', 'BSE'),
    defaultValue: 'NSE'
  },
  iv: { type: DataTypes.FLOAT },
  delta: { type: DataTypes.FLOAT },
  theta: { type: DataTypes.FLOAT },
  niftyAtEntry: { type: DataTypes.FLOAT },
  vixAtEntry: { type: DataTypes.FLOAT },
  psychology: {
    type: DataTypes.JSONB,
    defaultValue: {
      emotionBefore: '',
      emotionAfter: '',
      disciplineRating: null,
      followedPlan: null,
      mistakeTags: [],
      notes: ''
    }
  }
}, {
  sequelize,
  modelName: 'Trade',
  timestamps: true,
  indexes: [
    { fields: ['userId', 'entryDate'] },
    { fields: ['userId', 'status'] },
    { fields: ['userId', 'symbol'] }
  ],
  hooks: {
    beforeSave: (trade) => {
      if (trade.exitPrice && trade.status === 'CLOSED') {
        const mult = trade.tradeType === 'BUY' ? 1 : -1;
        const gross = mult * (trade.exitPrice - trade.entryPrice) * trade.quantity * trade.lotSize;
        trade.pnl = gross;
        trade.netPnl = gross - (trade.charges || 0);
        const invested = trade.entryPrice * trade.quantity * trade.lotSize;
        trade.pnlPercent = invested > 0 ? (gross / invested) * 100 : 0;
      }
    }
  }
});

User.hasMany(Trade, { foreignKey: 'userId', as: 'trades' });
Trade.belongsTo(User, { foreignKey: 'userId', as: 'user' });

export default Trade;
