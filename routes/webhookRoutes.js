const express = require("express");
const {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreateRequest,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, handleProductUpdateRequest);

// Ruta para el webhook de creación de órdenes
router.post("/orders/create", verifyHMAC, handleOrderCreateRequest);

module.exports = router;
