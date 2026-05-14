import { DataTypes, Model } from 'sequelize';
import sequelize from '../lib/sequelize.js';
import bcrypt from 'bcryptjs';

class User extends Model {
  async comparePassword(pwd) {
    if (!this.password) return false;
    return bcrypt.compare(pwd, this.password);
  }

  toJSON() {
    const values = { ...this.get() };
    delete values.password;
    delete values.sessions;
    return values;
  }
}

User.init({
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true
  },
  googleId: {
    type: DataTypes.STRING,
    allowNull: true
  },
  avatar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  authProvider: {
    type: DataTypes.ENUM('local', 'google'),
    defaultValue: 'local'
  },
  role: {
    type: DataTypes.ENUM('user', 'admin'),
    defaultValue: 'user'
  },
  profile: {
    type: DataTypes.JSONB,
    defaultValue: {
      gender: '',
      phone: '',
      country: ''
    }
  },
  riskManagement: {
    type: DataTypes.JSONB,
    defaultValue: {
      totalCapital: 0,
      availableMargin: 0,
      riskPerTrade: 1,
      maxDailyLoss: 2
    }
  },
  subscription: {
    type: DataTypes.JSONB,
    defaultValue: {
      plan: 'none',
      status: 'none',
      expiry: null,
      startedAt: null
    }
  },
  sessions: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  passwordResetToken: {
    type: DataTypes.STRING,
    allowNull: true
  },
  passwordResetExpiry: {
    type: DataTypes.DATE,
    allowNull: true
  },
  preferences: {
    type: DataTypes.JSONB,
    defaultValue: {
      defaultCapital: 100000,
      currency: 'INR'
    }
  }
}, {
  sequelize,
  modelName: 'User',
  timestamps: true,
  hooks: {
    beforeSave: async (user) => {
      if (user.changed('password') && user.password) {
        user.password = await bcrypt.hash(user.password, 12);
      }
    }
  }
});

export default User;
