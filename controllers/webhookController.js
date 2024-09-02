const config = require("../utils/config");
const crypto = require("crypto");
const shopifyService = require("../services/shopifyService");
const { globosNumerados, globosLatex } = require("../utils/products");
const { extractNumber } = require("../utils/functions");
const processedProducts = new Set();

let processing = false;
const queue = [];

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

async function processQueue() {
  if (processing || queue.length === 0) {
    return;
  }

  processing = true;

  const { req, res } = queue.shift();

  try {
    // Procesa la petición aquí, llamando a handleProductUpdate
    await handleProductUpdate(req, res);
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
  }

  processing = false;
  processQueue(); // Procesa la siguiente petición en la cola
}

// Endpoint para recibir el webhook
async function handleProductUpdate(req, res) {
  try {
    const productData = JSON.parse(req.body);

    console.log(
      "Procesando webhook para el producto",
      productData.id,
      "-",
      productData.title
    );
    if (processedProducts.has(productData.id)) {
      console.log(
        "Producto",
        productData.id,
        "-",
        productData.title,
        "ya procesado recientemente."
      );
      return res
        .status(200)
        .send(
          "Producto",
          productData.id,
          "-",
          productData.title,
          "ya procesado recientemente."
        );
    }

    processedProducts.add(productData.id);
    setTimeout(() => processedProducts.delete(productData.id), 300000);

    await shopifyService.handleProductUp(productData.id);

    console.log(
      "Webhook procesado para el producto",
      productData.id,
      "-",
      productData.title
    );
    return res
      .status(200)
      .send(
        "Webhook procesado para el producto",
        productData.id,
        "-",
        productData.title
      );
  } catch (error) {
    console.error("Error handling product update webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

async function handleProductUpdateRequest(req, res) {
  queue.push({ req, res });
  processQueue();
}

async function handleOrderCreate(req, res) {
  try {
    const orderData = JSON.parse(req.body);

    console.log(JSON.stringify(orderData, null, 2));

    await shopifyService.handleOrderCreate(orderData);

    return res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling order create webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

module.exports = {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreate,
};
