const express = require("express");
const {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreateRequest,
  handleGetZeroPriceProductsRequest,
  handleGetProductByIdRequest,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, handleProductUpdateRequest);

// Ruta para el webhook de creación de órdenes
router.post("/orders/create", verifyHMAC, handleOrderCreateRequest);

// Ruta de utilidad: productos con precio 0
router.get("/products/zero-price", handleGetZeroPriceProductsRequest);

// Ruta de utilidad: obtener producto por ID
router.get("/products/:id", handleGetProductByIdRequest);

module.exports = router;
