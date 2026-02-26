const express = require("express");
const {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreateRequest,
  handleGetZeroPriceProductsRequest,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, handleProductUpdateRequest);

// Ruta para el webhook de creación de órdenes
router.post("/orders/create", verifyHMAC, handleOrderCreateRequest);

// Ruta de utilidad: productos con precio 0
router.get("/products/zero-price", handleGetZeroPriceProductsRequest);

module.exports = router;
