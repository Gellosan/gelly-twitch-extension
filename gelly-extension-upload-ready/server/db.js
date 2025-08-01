const mongoose = require('mongoose');

mongoose.connect(
  'mongodb+srv://Gellosan:VbOfArgq6Su00OC@gellocluster.gzlntn3.mongodb.net/?retryWrites=true&w=majority&appName=GelloCluster',
  {
    useNewUrlParser: true,
    useUnifiedTopology: true
  }
).then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

  }


module.exports = connectDB;
