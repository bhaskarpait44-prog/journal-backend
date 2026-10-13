import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production';
const dbUrl = process.env.DATABASE_URL || '';
const requiresSsl = process.env.DB_SSL === 'true' || 
                    dbUrl.includes('neon.tech') || 
                    dbUrl.includes('sslmode=require') || 
                    (isProduction && !dbUrl.includes('localhost') && !dbUrl.includes('127.0.0.1'));

const sequelize = new Sequelize(dbUrl, {
  dialect: 'postgres',
  logging: process.env.DB_LOGGING === 'true' ? console.log : false,
  dialectOptions: requiresSsl ? {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  } : {}
});

export default sequelize;
