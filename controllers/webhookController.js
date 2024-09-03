const config = require("../utils/config");
const crypto = require("crypto");
const shopifyService = require("../services/shopifyService");
const { globosNumerados, globosLatex } = require("../utils/products");
const { extractNumber } = require("../utils/functions");

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

  const { req, res, type } = queue.shift();

  try {
    if (type === "product") {
      await handleProductUpdate(req, res);
    } else if (type === "order") {
      await handleOrderCreate(req, res);
    }
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).send("Internal Server Error");
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

    // Enviar respuesta inmediatamente
    res
      .status(200)
      .send(
        `Webhook recibido y procesado para el producto ${productData.id} - ${productData.title}`
      );

    // Procesar el producto en segundo plano
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

    // Enviar respuesta inmediatamente
    res.status(200).send("Webhook recibido");

    // Procesar el pedido en segundo plano
    shopifyService
      .handleOrderCreate(orderData)
      .then(() => {
        console.log("Pedido procesado con éxito:", orderData.id);
      })
      .catch((error) => {
        console.error("Error al procesar pedido:", orderData.id, error);
      });
  } catch (error) {
    console.error("Error handling order create webhook:", error);
    // Aunque el procesamiento de pedidos ya debería haber enviado una respuesta,
    // si hay un error al analizar el cuerpo de la solicitud, se envía un error interno.
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

module.exports = {
  verifyHMAC,
  handleProductUpdateRequest,
  handleOrderCreateRequest,
};
