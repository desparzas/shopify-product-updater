require("dotenv").config();

const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const SHOP = process.env.SHOP;
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const SCOPES = process.env.SCOPES;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;
const USE_GRAPHQL = process.env.USE_GRAPHQL;
const PORT = process.env.PORT;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SKIP_WEBHOOK_HMAC = process.env.SKIP_WEBHOOK_HMAC;
const SKIP_SSL_VERIFY = process.env.SKIP_SSL_VERIFY;
const MONGODB_URI = process.env.MONGODB_URI;
module.exports = {
  ACCESS_TOKEN,
  SHOP,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES,
  SHOPIFY_API_VERSION,
  USE_GRAPHQL,
  PORT,
  WEBHOOK_SECRET,
  SKIP_WEBHOOK_HMAC,
  SKIP_SSL_VERIFY,
  MONGODB_URI,
};
