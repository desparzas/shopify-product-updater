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

async function handleOrderCreate(req, res) {
  try {
    const orderData = JSON.parse(req.body);
    // for (const orderItem of orderData.line_items) {
    //   console.log(`Procesando producto ${title} en la orden ${orderData.name}`);
    //   const { id, properties, quantity, title, product_id, variant_id } =
    //     orderItem;

    //   const product = await shopifyService.getProductById(product_id);

    //   const { product_type } = product;

    //   // Validar si el producto es un Ramo Personalizado
    //   if (product_type !== "Ramo Personalizado") {
    //     continue;
    //   }

    //   if (properties.length === 0) {
    //     continue;
    //   }

    //   // obtener los metadatos del producto
    //   const metafields = await shopifyService.getProductCustomMetafields(
    //     product_id
    //   );

    //   const dataExtra = metafields.find(
    //     (metafield) => metafield.key === "dataExtra"
    //   );
    // }
    console.log(JSON.stringify(orderData, null, 2));

    return res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling order create webhook:", error);
    res.status(500).send("Internal Server Error");
  }
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
      return res.status(200).send("Evento ya procesado recientemente.");
    }

    processedProducts.add(productData.id);
    setTimeout(() => processedProducts.delete(productData.id), 120000);

    await shopifyService.actualizarBundlesDeProducto(productData.id);

    console.log("Webhook procesado para el producto ", productData.title);
    return res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling product update webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

async function handleProductUpdateRequest(req, res) {
  queue.push({ req, res });
  processQueue();
}

module.exports = {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreate,
};
