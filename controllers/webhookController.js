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

async function handleOrderCreate(req, res) {
  try {
    const orderData = JSON.parse(req.body);

    console.log(JSON.stringify(orderData, null, 2));

    return res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling order create webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

// Endpoint para recibir el webhook
async function handleProductUpdate(req, res) {
  try {
    const productData = JSON.parse(req.body);
    console.log(
      "Procesando webhook para el producto ",
      productData.id,
      "-",
      productData.title
    );
    if (processedProducts.has(productData.id)) {
      return res.status(200).send("Evento ya procesado recientemente.");
    }

    processedProducts.add(productData.id);
    setTimeout(() => processedProducts.delete(productData.id), 120000);

    const tieneProductos = await shopifyService.tieneProductos(productData.id);
    if (tieneProductos) {
      console.log(
        `El producto ${productData.title} tiene productos, no se procesará`
      );
      return res.status(200).send("El producto tiene productos");
    }

    const contenidoEnRamo = await shopifyService.contenidoEnPaquete(
      productData.id,
      "Ramo Simple"
    );

    const contenidoEnGloboNumero = await shopifyService.contenidoEnPaquete(
      productData.id,
      "Globo de Número"
    );

    const contenidoEnRamoDobleNumerado =
      await shopifyService.contenidoEnPaquete(
        productData.id,
        "Ramo Doble Numerado"
      );

    if (contenidoEnRamo) {
      console.log(
        `El producto ${productData.title} está contenido en un ramo simple`
      );
      await shopifyService.actualizarRamosSimplesDeProducto(productData.id);
      console.log(
        "Ramos simples actualizados del producto ",
        productData.title
      );
    } else {
      console.log(
        `El producto ${productData.title} no está contenido en un ramo simple`
      );
    }

    if (contenidoEnGloboNumero) {
      console.log(
        `El producto ${productData.title} está contenido en un globo de número`
      );
      await shopifyService.actualizarGlobosNumeradosDeProducto(productData.id);
    } else {
      console.log(
        `El producto ${productData.title} no está contenido en un globo de número`
      );
    }

    if (contenidoEnRamoDobleNumerado) {
      console.log(
        `El producto ${productData.title} está contenido en un ramo doble numerado`
      );
      await shopifyService.actualizarRamosDoblesNumeradosDeProducto(
        productData.id
      );
    } else {
      console.log(
        `El producto ${productData.title} no está contenido en un ramo doble numerado`
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
  handleOrderCreate,
};
