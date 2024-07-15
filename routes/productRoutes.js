const express = require("express");
const {
  getProducts,
  getProduct,
  getRamos,
} = require("../controllers/productController.js");

const router = express.Router();

router.get("/products", getProducts);
router.get("/products/:id", getProduct);
router.get("/ramos", getRamos);

module.exports = router;
