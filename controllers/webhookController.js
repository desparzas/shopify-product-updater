const config = require("../utils/config");
const crypto = require("crypto");
const shopifyService = require("../services/shopifyService");
const { globosNumerados, globosLatex } = require("../utils/products");
const { extractNumber } = require("../utils/functions");
const processedProducts = new Set();
const queue = []; // Cola para manejar las peticiones
let isProcessing = false; // Indicador para saber si la cola está siendo procesada

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
    for (const orderItem of orderData.line_items) {
      const { id, properties, quantity, title, product_id } = orderItem;

      console.log(`Procesando producto ${title} en la orden ${orderData.name}`);

      if (properties.length === 0) {
        console.log("El producto no tiene propiedades");
        continue;
      }

      const colorNumero = properties.find(
        (property) => property.name === "Color del Globo de Número"
      )?.value;

      const primerNumero = properties.find(
        (property) => property.name === "Primer Número del Globo"
      )?.value;

      const segundoNumero = properties.find(
        (property) => property.name === "Segundo Número del Globo"
      )?.value;

      const coloresLatex = properties.find(
        (property) => property.name === "Colores del Globo de Látex"
      )?.value;

      if (!(colorNumero && primerNumero && segundoNumero && coloresLatex)) {
      }
      // GLOBO DE NUMERO
      const globoNumeradoId = globosNumerados[colorNumero];
      const globoNumerado = await shopifyService.getProductById(
        globoNumeradoId
      );
      const globoNumeradoVariantes = globoNumerado.variants;

      for (const variant of globoNumeradoVariantes) {
        const numero = extractNumber(variant.title);
        const extPrimerNumero = extractNumber(primerNumero);
        const extSegundoNumero = extractNumber(segundoNumero);
        if (numero === extPrimerNumero) {
          console.log("Encontré la variante del primer número");
          const precioPrimerNumero = variant.price;
          console.log("Precio del primer número:", precioPrimerNumero);
          const inventarioPrimerNumero = variant.inventory_quantity;
          console.log("Inventario del primer número:", inventarioPrimerNumero);
          const nuevoInventarioPrimerNumero = inventarioPrimerNumero - quantity;

          console.log(
            "Nuevo inventario del primer número:",
            nuevoInventarioPrimerNumero
          );
          if (nuevoInventarioPrimerNumero < 0) {
            console.log("Inventario insuficiente para el primer número");
          } else {
            await shopifyService.reducirInventario(
              variant.id,
              nuevoInventarioPrimerNumero
            );
          }
        }
        if (numero === extSegundoNumero) {
          console.log("Encontré la variante del segundo número");
          const precioSegundoNumero = variant.price;
          console.log("Precio del segundo número:", precioSegundoNumero);

          const inventarioSegundoNumero = variant.inventory_quantity;
          console.log(
            "Inventario del segundo número:",
            inventarioSegundoNumero
          );

          const nuevoInventarioSegundoNumero =
            inventarioSegundoNumero - quantity;

          console.log(
            "Nuevo inventario del segundo número:",
            nuevoInventarioSegundoNumero
          );

          if (nuevoInventarioSegundoNumero < 0) {
            console.log("Inventario insuficiente para el segundo número");
          } else {
            await shopifyService.reducirInventario(
              variant.id,
              nuevoInventarioSegundoNumero
            );
          }
        }
      }

      // GLOBOS DE LATEX

      if (coloresLatex.length === 0) {
        console.log("El producto no tiene colores de látex");
        continue;
      }

      for (const color of coloresLatex) {
        const globoRedondoId = globosLatex[color];
        const globoRedondo = await shopifyService.getProductById(
          globoRedondoId
        );
        const globoRedondoVariantes = globoRedondo.variants;

        for (const variant of globoRedondoVariantes) {
          const precioGloboRedondo = variant.price;
          console.log("Precio del globo redondo:", precioGloboRedondo);

          const inventarioGloboRedondo = variant.inventory_quantity;
          console.log("Inventario del globo redondo:", inventarioGloboRedondo);

          const nuevoInventarioGloboRedondo = inventarioGloboRedondo - quantity;
          console.log(
            "Nuevo inventario del globo redondo:",
            nuevoInventarioGloboRedondo
          );

          if (nuevoInventarioGloboRedondo < 0) {
            console.log("Inventario insuficiente para el globo redondo");
          } else {
            await shopifyService.reducirInventario(
              variant.id,
              nuevoInventarioGloboRedondo
            );
          }
        }
      }
    }

    console.log(JSON.stringify(orderData, null, 2));

    return res.status(200).send("Webhook recibido");
  } catch (error) {
    console.error("Error handling order create webhook:", error);
    res.status(500).send("Internal Server Error");
  }
}

// Función para procesar la cola
async function processQueue() {
  if (isProcessing || queue.length === 0) {
    return;
  }

  isProcessing = true;
  const { req, res } = queue.shift(); // Obtén la primera petición en la cola

  try {
    await handleProductUpdate(req, res); // Invoca handleProductUpdate aquí
  } finally {
    isProcessing = false;
    processQueue(); // Procesa la siguiente petición en la cola
  }
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

// Middleware para encolar las peticiones
function enqueueRequest(req, res, next) {
  queue.push({ req, res });
  processQueue(); // Procesa la cola cada vez que se agrega una nueva petición
}

module.exports = {
  verifyHMAC,
  enqueueRequest,
  handleOrderCreate,
};
