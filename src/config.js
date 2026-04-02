require("dotenv").config();
const path = require("path");

module.exports = {
  port: Number(process.env.PORT || 3000),
  appUrl: process.env.APP_URL || "http://localhost:3000",
  sessionSecret: process.env.SESSION_SECRET || "change_me",
  adminLogin: process.env.ADMIN_LOGIN || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  dbPath: path.resolve(process.cwd(), process.env.DB_PATH || "./data/app.db"),
  uploadDir: path.resolve(process.cwd(), process.env.UPLOAD_DIR || "./uploads"),
};
