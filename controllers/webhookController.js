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
    // console.log("Webhook recibido");
    // console.log("_________________");
    // console.log(productData);
    // console.log("_________________");
    if (!productData) {
      console.error("No es un producto");
      return res.status(400).send("Bad Request");
    }

    console.log("Producto actualizado:", productData.id);

    const product = await shopifyService.getProductById(productData.id);
    if (!product) {
      console.error(
        "Producto no encontrado en la base de datos desde el handler"
      );
      return res.status(404).send("Not Found");
    }

    const contenidoEnRamo = await shopifyService.contenidoEnRamo(
      productData.id
    );

    await shopifyService.actualizarRamosSimplesDeProducto(productData.id);
    if (contenidoEnRamo) {
      console.log("El producto actualizado está contenido en un ramo");
      return res.status(200).send("Webhook recibido");
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
