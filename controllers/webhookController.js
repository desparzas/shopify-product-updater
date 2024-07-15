const config = require("../utils/config");
const crypto = require("crypto");
const shopifyService = require("../services/shopifyService"); // Asegúrate de ajustar la ruta según tu estructura de carpetas

// Middleware para validar el HMAC
function verifyHMAC(req, res, next) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const hash = crypto
    .createHmac("sha256", config.WEBHOOK_SECRET)
    .update(req.body, "utf8", "hex")
    .digest("base64");

  if (hash !== hmac) {
    console.log("HMAC no coincide");
    return res.status(401).send("Unauthorized");
  } else {
    console.log("HMAC coincide");
  }

  next();
}

// Endpoint para recibir el webhook
async function handleProductUpdate(req, res) {
  try {
    const productData = JSON.parse(req.body);
    if (!productData.id) {
      console.error("No se ha recibido el ID del producto");
      return res.status(400).send("Bad Request");
    }
    console.log("____________________________________");
    console.log("Producto actualizado:", productData.id);
    console.log("____________________________________");

    // Buscar el producto actualizado en la base de datos
    const product = await shopifyService.getProductById(productData.id);
    if (!product) {
      console.error("Producto no encontrado en la base de datos");
      return res.status(404).send("Not Found");
    }

    // Actualizar ramos o realizar otras acciones necesarias
    await shopifyService.updateRamosSimples(productData.id);

    res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling product update webhook:");
    res.status(500).send("Internal Server Error");
  }
}

module.exports = {
  verifyHMAC,
  handleProductUpdate,
};
