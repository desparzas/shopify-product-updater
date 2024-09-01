const mongoose = require("mongoose");

const config = require("../utils/config");

const uri = config.MONGODB_URI;

const connectDb = async () => {
  try {
    await mongoose.connect(uri, {});
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error.message);
  }
};

module.exports = connectDb;
