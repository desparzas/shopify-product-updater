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
    const { line_items, name: orderName } = orderData;

    for (const orderItem of line_items) {
      const { id, properties, quantity, title, product_id, variant_id } =
        orderItem;

      console.log(`Procesando producto ${title} en la orden ${orderName}`);

      // Obteniendo el producto desde Shopify
      const product = await shopifyService.getProductById(product_id);
      const { product_type } = product;

      // Validar si el producto es un Ramo Personalizado
      if (product_type !== "Ramo Personalizado") {
        continue;
      }

      // Validar si hay propiedades
      if (properties.length === 0) {
        continue;
      }

      // Obtener los metadatos del producto
      const metafields = await shopifyService.getProductCustomMetafields(
        product_id
      );
      const dataExtraM = metafields.find(
        (metafield) => metafield.key === "data_extra"
      );

      if (!dataExtraM) {
        continue;
      }

      const dataExtra = JSON.parse(dataExtraM.value);

      if (!dataExtra) {
        continue;
      }

      const { idVariantPrimerNumero, idVariantSegundoNumero, dataGlobosLatex } =
        dataExtra;

      // recorrer el objeto dataGlobosLatex
      for (const t of Object.keys(dataGlobosLatex)) {
        const { id, cantidad } = dataGlobosLatex[t];
        const variantB = await shopifyService.getVariant(id);
        const globoB = await shopifyService.getProductById(variantB.product_id);
        let listaProductosB = await shopifyService.getProductCustomMetafields(
          globoB.id
        );
        listaProductosB = listaProductosB.find(
          (metafield) =>
            metafield.key === "lista_de_productos" &&
            metafield.namespace === "custom"
        );
        listaProductosB = JSON.parse(listaProductosB.value);
        listaProductosB = listaProductosB.map((producto) => {
          const id = parseInt(producto.split("/").pop());
          return id;
        });
        const productosB = await Promise.all(
          listaProductosB.map((id) => shopifyService.getProductById(id))
        );
        const productosInventariablesB = productosB.filter(
          (producto) => producto.variants[0].inventory_management === "shopify"
        );
        const globoLatexInsumo = productosInventariablesB[0];
        const variantInsumoB = globoLatexInsumo.variants[0];
        await shopifyService.reducirInventario(variantInsumoB.id, cantidad);
        console.log(
          "Reduciendo inventario de globo latex",
          globoLatexInsumo.title,
          "en",
          cantidad,
          "unidades"
        );
      }

      const variant1 = await shopifyService.getVariant(idVariantPrimerNumero);
      const globo1 = await shopifyService.getProductById(variant1.product_id);
      const option1 = variant1.option1;

      const metafieldsGlobo1 = await shopifyService.getProductCustomMetafields(
        globo1.id
      );
      let listaProductos1 = metafieldsGlobo1.find(
        (metafield) =>
          metafield.key === "lista_de_productos" &&
          metafield.namespace === "custom"
      );
      listaProductos1 = JSON.parse(listaProductos1.value);
      listaProductos1 = listaProductos1.map((producto) => {
        const id = parseInt(producto.split("/").pop());
        return id;
      });
      const productos1 = await Promise.all(
        listaProductos1.map((id) => shopifyService.getProductById(id))
      );
      const productosInventariables1 = productos1.filter(
        (producto) => producto.variants[0].inventory_management === "shopify"
      );

      const globoNumeroInsumo = productosInventariables1[0];
      const variantInsumo = globoNumeroInsumo.variants.find(
        (variant) => variant.option1 === option1
      );

      await shopifyService.reducirInventario(variantInsumo.id, 1);

      const variant2 = await shopifyService.getVariant(idVariantSegundoNumero);
      const globo2 = await shopifyService.getProductById(variant2.product_id);
      const option2 = variant2.option1;

      const metafieldsGlobo2 = await shopifyService.getProductCustomMetafields(
        globo2.id
      );

      let listaProductos2 = metafieldsGlobo2.find(
        (metafield) =>
          metafield.key === "lista_de_productos" &&
          metafield.namespace === "custom"
      );

      listaProductos2 = JSON.parse(listaProductos2.value);

      listaProductos2 = listaProductos2.map((producto) => {
        const id = parseInt(producto.split("/").pop());
        return id;
      });

      const productos2 = await Promise.all(
        listaProductos2.map((id) => shopifyService.getProductById(id))
      );

      const productosInventariables2 = productos2.filter(
        (producto) => producto.variants[0].inventory_management === "shopify"
      );

      const globoNumeroInsumo2 = productosInventariables2[0];

      const variantInsumo2 = globoNumeroInsumo2.variants.find(
        (variant) => variant.option1 === option2
      );

      await shopifyService.reducirInventario(variantInsumo2.id, 1);
    }

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
