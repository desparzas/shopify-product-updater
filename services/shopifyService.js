const config = require("../utils/config");
const Shopify = require("shopify-api-node");
const fs = require("fs");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;

const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
});

async function retryWithBackoff(fn, retries = 5, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (error.response.statusCode === 429 && retries > 0) {
      // console.log(`Rate limit hit, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    } else {
      throw error;
    }
  }
}

async function listProducts() {
  return retryWithBackoff(async () => {
    const products = await shopify.product.list();
    for (let product of products) {
      if (product.product_type === "Ramo") {
        product.metafields = await getProductMetafields(product.id);
      }
    }
    return products;
  });
}

async function getProductById(id) {
  return retryWithBackoff(async () => {
    return await shopify.product.get(id);
  });
}

async function getProductMetafields(productId) {
  return retryWithBackoff(async () => {
    return await shopify.metafield.list({
      metafield: { owner_resource: "product", owner_id: productId },
    });
  });
}

async function getProductByProductType(productType) {
  return retryWithBackoff(async () => {
    return await shopify.product.list({ product_type: productType });
  });
}

async function getProductosFromRamo(ramo) {
  try {
    const metafields = await getProductMetafields(ramo.id);
    if (!metafields.length) return [];

    const data_productos = [];
    for (let i = 1; i <= 20; i++) {
      const productoMetafield = metafields.find(
        (metafield) => metafield.key === `producto_${i}`
      );
      const cantidadMetafield = metafields.find(
        (metafield) => metafield.key === `cantidad_del_producto_${i}`
      );

      if (productoMetafield && cantidadMetafield) {
        const productoId = productoMetafield.value.replace(/[^0-9]/g, "");
        const cantidad = parseFloat(cantidadMetafield.value);

        const producto = await getProductById(productoId);
        if (producto) {
          data_productos.push({
            producto: {
              id: producto.id,
              title: producto.title,
              product_type: producto.product_type,
              variants: producto.variants,
            },
            cantidad,
          });
        } else {
          console.error("Producto no encontrado para ID:", productoId);
        }
      }
    }
    return data_productos;
  } catch (error) {
    console.error("Error obteniendo los productos de un ramo");
    return [];
  }
}

async function obtenerRamosSimplesContienenProducto(productId) {
  return retryWithBackoff(async () => {
    let ramos = await getProductByProductType("Ramo Simple");
    ramos = await Promise.all(
      ramos.map(async (ramo) => {
        ramo.productos = await getProductosFromRamo(ramo);
        return ramo;
      })
    );
    return ramos.filter((ramo) =>
      ramo.productos.some((producto) => producto.producto.id === productId)
    );
  });
}

async function actualizarRamosSimplesDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
    }
    const precioNuevo = parseFloat(product.variants[0].price);
    const ramos = await obtenerRamosSimplesContienenProducto(id);

    const ramosSimples = ramos.filter((ramo) => {
      return (
        ramo.productos.every(
          (producto) => producto.producto.variants.length === 1
        ) && ramo.variants.length === 1
      );
    });

    for (const ramo of ramosSimples) {
      let precioRamo = 0;
      ramo.productos.forEach((producto) => {
        const precioProducto = parseFloat(producto.producto.variants[0].price);
        const cantidad = producto.cantidad;
        precioRamo +=
          (producto.producto.id !== id ? precioProducto : precioNuevo) *
          cantidad;
      });
      const precioRamoNuevo = precioRamo.toFixed(2);
      if (precioRamoNuevo !== ramo.variants[0].price) {
        console.log(
          `Actualizado el precio del ramo ${ramo.title} a ${precioRamoNuevo} de ${ramo.variants[0].price} a ${precioRamoNuevo}`
        );
        await shopify.productVariant.update(ramo.variants[0].id, {
          price: precioRamoNuevo,
        });
      }
    }

    console.log("Ramos simples actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando ramos simples");
  }
}

async function contenidoEnRamoSimple(productId) {
  return retryWithBackoff(async () => {
    const ramos = await getProductByProductType("Ramo Simple");
    for (let ramo of ramos) {
      const productosEnRamo = await getProductosFromRamo(ramo);
      const productosIds = productosEnRamo.map(
        (producto) => producto.producto.id
      );
      if (productosIds.includes(productId)) {
        return true; // El producto está en el ramo
      }
    }
    return false; // El producto no está en ningún ramo
  });
}

module.exports = {
  listProducts,
  getProductById,
  getProductMetafields,
  getProductByProductType,
  getProductosFromRamo,
  obtenerRamosSimplesContienenProducto,
  actualizarRamosSimplesDeProducto,
  contenidoEnRamoSimple,
};
