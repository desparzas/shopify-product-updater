const config = require("../utils/config");
const crypto = require("crypto");
const shopifyService = require("../services/shopifyService");
const { getProductByIdGraphql } = require("../services/shopifyGraphql");
const { globosNumerados, globosLatex } = require("../utils/products");
const { extractNumber } = require("../utils/functions");
const processedProducts = new Set();
let orderProcessingFlag = false;
let processing = false;
const queue = [];

// Middleware para validar el HMAC
function verifyHMAC(req, res, next) {
  if (String(config.SKIP_WEBHOOK_HMAC).toLowerCase() === "true") {
    return next();
  }

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

  const { req, res, type } = queue.shift();

  try {
    if (type === "product") {
      await handleProductUpdate(req, res);
    } else if (type === "order") {
      await handleOrderCreate(req, res);
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }

  processing = false;
  processQueue(); // Procesa la siguiente petición en la cola
}

// Función para manejar las peticiones de actualización de productos
async function handleProductUpdate(req, res) {
  try {
    const productData = JSON.parse(req.body);

    console.log(
      "Procesando webhook para el producto",
      productData.id,
      "-",
      productData.title
    );

    // Si el producto ya ha sido procesado recientemente, ignorar
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
          `Producto ${productData.id} - ${productData.title} ya procesado recientemente.`
        );
    }

    // Si se está procesando una orden, no procesar la actualización del producto
    if (orderProcessingFlag) {
      console.log(
        `Producto ${productData.id} - ${productData.title} no procesado debido a procesamiento de orden en curso.`
      );
      return res
        .status(200)
        .send(
          `Producto ${productData.id} - ${productData.title} no procesado debido a procesamiento de orden en curso.`
        );
    }

    // Marca el producto como procesado
    processedProducts.add(productData.id);
    setTimeout(() => processedProducts.delete(productData.id), 10000);

    res
      .status(200)
      .send(
        `Webhook recibido y procesado para el producto ${productData.id} - ${productData.title}`
      );

    shopifyService
      .handleProductUp(productData.id)
      .then(() => {
        console.log(
          `Webhook procesado con éxito para el producto ${productData.id} - ${productData.title}`
        );
      })
      .catch((error) => {
        console.error(
          `Error al procesar webhook para el producto ${productData.id} - ${productData.title}:`,
          error
        );
      });
  } catch (error) {
    console.error("Error handling product update webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

// Función para manejar las peticiones de creación de órdenes
async function handleOrderCreate(req, res) {
  try {
    const orderData = JSON.parse(req.body);

    orderProcessingFlag = true;

    res.status(200).send("Webhook recibido");

    shopifyService
      .handleOrderCreate(orderData)
      .then(() => {
        console.log("Pedido procesado con éxito:", orderData.id);
      })
      .catch((error) => {
        console.error("Error al procesar pedido:", orderData.id, error);
      })
      .finally(() => {
        orderProcessingFlag = false;
      });
  } catch (error) {
    console.error("Error handling order create webhook:", error);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
}
// Función para agregar peticiones a la cola
async function addToQueue(req, res, type) {
  queue.push({ req, res, type });
  processQueue();
}

// Controladores para los endpoints
async function handleProductUpdateRequest(req, res) {
  addToQueue(req, res, "product");
}

async function handleOrderCreateRequest(req, res) {
  addToQueue(req, res, "order");
}

async function handleGetZeroPriceProductsRequest(req, res) {
  try {
    const products = await shopifyService.getProductsWithZeroPrice();

    const rows = [];
    for (const product of products) {
      for (const variant of product.zeroVariants) {
        rows.push([
          product.id,
          `"${product.title.replace(/"/g, '""')}"`,
          variant.id,
          `"${variant.title.replace(/"/g, '""')}"`,
          variant.price,
        ].join(","));
      }
    }

    const csv = ["product_id,product_title,variant_id,variant_title,price", ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="productos-precio-cero.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    console.error("Error obteniendo productos con precio 0:", error);
    return res.status(500).json({ error: "Error obteniendo productos" });
  }
}

async function handleGetProductByIdRequest(req, res) {
  try {
    const { id } = req.params;
    const product = await getProductByIdGraphql(parseInt(id, 10));
    if (!product) return res.status(404).json({ error: "Producto no encontrado" });
    return res.status(200).json(product);
  } catch (error) {
    console.error("Error obteniendo producto:", error);
    return res.status(500).json({ error: "Error obteniendo producto" });
  }
}

module.exports = {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreateRequest,
  handleGetZeroPriceProductsRequest,
  handleGetProductByIdRequest,
};
