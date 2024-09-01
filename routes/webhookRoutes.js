const express = require("express");
const {
  verifyHMAC,
  handleProductUpdateRequest,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, handleProductUpdateRequest);
module.exports = router;
