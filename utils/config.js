require("dotenv").config();

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOP = process.env.SHOP;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES = process.env.SCOPES;
const PORT = process.env.PORT;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const MONGODB_URI = process.env.MONGODB_URI;
module.exports = {
  ACCESS_TOKEN,
  SHOP,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES,
  PORT,
  WEBHOOK_SECRET,
  MONGODB_URI,
};
