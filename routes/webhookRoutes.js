const express = require("express");
const {
  verifyHMAC,
  handleProductUpdate,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, handleProductUpdate);

module.exports = router;
