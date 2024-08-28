const express = require("express");
const {
  verifyHMAC,
  handleProductUpdate,
  handleOrderCreate,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, handleProductUpdate);

// Ruta para el webhook de creación de ordenes
router.post("/orders/create", verifyHMAC, handleOrderCreate);

module.exports = router;
