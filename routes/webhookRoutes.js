const express = require("express");
const {
  verifyHMAC,
  enqueueRequest,
  handleOrderCreate,
} = require("../controllers/webhookController");

const router = express.Router();

// Ruta para el webhook de actualización de productos
router.post("/products/update", verifyHMAC, enqueueRequest);
// Ruta para el webhook de creación de ordenes
router.post("/orders/create", verifyHMAC, handleOrderCreate);

module.exports = router;
