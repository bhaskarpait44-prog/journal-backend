import sequelize from './src/lib/sequelize.js';
import User from './src/models/User.js';

// The email of the user you want to promote to admin
const email = 'admin@tradelog.in'; 

async function promote() {
  try {
    await sequelize.authenticate();
    console.log('Connected to database.');
    
    const user = await User.findOne({ where: { email: email.toLowerCase().trim() } });
    
    if (user) {
      await user.update({ role: 'admin' });
      console.log(`SUCCESS: User ${email} has been promoted to admin.`);
    } else {
      console.log(`ERROR: User with email "${email}" not found.`);
      console.log('Please make sure you have signed up with this email first.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit();
  }
}

promote();
