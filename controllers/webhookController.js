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
    if (!productData) {
      console.error("No es un producto");
      return res.status(400).send("Bad Request");
    }

    const contenidoEnRamo = await shopifyService.contenidoEnRamo(
      productData.id
    );

    if (contenidoEnRamo) {
      console.log(`El producto ${productData.title} está contenido en un ramo`);
      console.log("Actualizando ramos simples");
      await shopifyService.actualizarRamosSimplesDeProducto(productData.id);
      console.log("Ramos simples actualizados");
      return res.status(200).send("Webhook recibido");
    } else {
      console.log(
        `El producto ${productData.title} no está contenido en un ramo`
      );
    }

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
