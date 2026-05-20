import sequelize from './src/lib/sequelize.js';
import User from './src/models/User.js';

async function findAdmin() {
  try {
    await sequelize.authenticate();
    const admin = await User.findOne({ where: { role: 'admin' } });
    if (admin) {
      console.log('Admin found:', admin.email);
    } else {
      console.log('No admin found.');
      // Optionally create one if none exists
      /*
      const newAdmin = await User.create({
        name: 'Admin',
        email: 'admin@tradelog.in',
        password: 'password123',
        role: 'admin'
      });
      console.log('Admin created: admin@tradelog.in / password123');
      */
    }
  } catch (err) {
    console.error(err);
  } finally {
    process.exit();
  }
}

findAdmin();
