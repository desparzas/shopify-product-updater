const config = require("../utils/config");
const crypto = require("crypto");
const shopifyService = require("../services/shopifyService");
const processedProducts = new Set();
// Middleware para validar el HMAC
function verifyHMAC(req, res, next) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  const hash = crypto
    .createHmac("sha256", config.WEBHOOK_SECRET)
    .update(req.body, "utf8", "hex")
    .digest("base64");

  if (hash !== hmac) {
    return res.status(401).send("Unauthorized");
  }

  next();
}

// Endpoint para recibir el webhook
async function handleProductUpdate(req, res) {
  try {
    const productData = JSON.parse(req.body);
    if (processedProducts.has(productData.id)) {
      return res.status(200).send("Evento ya procesado recientemente.");
    }

    processedProducts.add(productData.id);
    setTimeout(() => processedProducts.delete(productData.id), 90000);

    console.log("Procesando webhook para el producto ", productData.title);
    console.log("ARRAY DE PRODUCTOS PROCESADOS: ", processedProducts);

    const contenidoEnRamo = await shopifyService.contenidoEnRamo(
      productData.id
    );

    if (contenidoEnRamo) {
      console.log(`El producto ${productData.title} está contenido en un ramo`);
      await shopifyService.actualizarRamosSimplesDeProducto(productData.id);
      console.log(
        "Ramos simples actualizados del producto ",
        productData.title
      );
    } else {
      console.log(
        `El producto ${productData.title} no está contenido en un ramo`
      );
    }
    console.log("Webhook procesado para el producto ", productData.title);
    return res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling product update webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

module.exports = {
  verifyHMAC,
  handleProductUpdate,
};
