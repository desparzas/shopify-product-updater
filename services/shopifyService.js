const config = require("../utils/config");
const Shopify = require("shopify-api-node");
const fs = require("fs");
const { get } = require("http");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;

const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
});

async function listProducts() {
  try {
    const products = await shopify.product.list();
    for (let product of products) {
      if (product.product_type === "Ramo") {
        product.metafields = await getProductMetafields(product.id);
      }
    }
    return products;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}

async function getProductById(id) {
  try {
    const product = await shopify.product.get(id);
    return product;
  } catch (error) {
    console.error("Error fetching product:", error);
    throw error;
  }
}

async function getProductMetafields(productId) {
  try {
    const metafields = await shopify.metafield.list({
      metafield: { owner_resource: "product", owner_id: productId },
    });
    return metafields;
  } catch (error) {
    console.error("Error fetching product metafields:", error);
    throw error;
  }
}

async function getProductByProductType(productType) {
  try {
    const products = await shopify.product.list({ product_type: productType });

    return products;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}

async function getProductosFromRamo(ramo) {
  try {
    const metafields = await getProductMetafields(ramo.id);
    const data_productos = [];
    for (let i = 1; i <= 20; i++) {
      let producto = metafields.find(
        (metafield) => metafield.key === `producto_${i}`
      );
      const cantidad = metafields.find(
        (metafield) => metafield.key === `cantidad_del_producto_${i}`
      );
      if (producto && cantidad) {
        producto.value = producto.value.replace(/[^0-9]/g, "");
        let p = await getProductById(producto.value);
        p = {
          id: p.id,
          title: p.title,
          product_type: p.product_type,
          variants: p.variants,
        };
        data_productos.push({
          producto: p,
          cantidad: cantidad.value,
        });
      }
    }
    return data_productos;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}

async function getRamosByProduct(productId) {
  try {
    let ramos = await getProductByProductType("Ramo");
    for (let product of ramos) {
      product.productos = await getProductosFromRamo(product);
    }
    // Filtrar a los ramos cuyos productos contengan el producto con el id recibido
    ramos = ramos.filter((ramo) => {
      const productos = ramo.productos.map((producto) => producto.producto.id);
      return productos.includes(productId);
    });
    return ramos;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}

async function updateRamosSimples(productId) {
  try {
    const product = await getProductById(productId);
    const precioNuevo = parseFloat(product.variants[0].price);
    const ramos = await getRamosByProduct(productId);

    const ramosSimples = ramos.filter((ramo) => {
      const tieneSoloUnVariant = ramo.productos.every(
        (producto) => producto.producto.variants.length === 1
      );
      return tieneSoloUnVariant && ramo.variants.length === 1;
    });

    const updatePromises = ramosSimples.map(async (ramo) => {
      let precioRamo = 0;
      for (let producto of ramo.productos) {
        const precioProducto = parseFloat(producto.producto.variants[0].price);
        const cantidad = parseFloat(producto.cantidad);

        precioRamo +=
          producto.producto.id !== productId
            ? precioProducto * cantidad
            : precioNuevo * cantidad;
      }

      const precioRamoNuevo = precioRamo.toFixed(2);
      console.log("Precio del ramo nuevo: ", precioRamoNuevo);

      try {
        if (precioRamoNuevo !== ramo.variants[0].price) {
          console.log(
            `Updating variant ${ramo.variants[0].price} to price ${precioRamoNuevo}`
          );
          const now = new Date();
          const productName = ramo.title;
          const variant = ramo.variants[0];
          const updatedAt = new Date(variant.updated_at);
          // Verificar si el variant ha sido actualizado en los últimos 60 segundos
          if (now - updatedAt > 60 * 1000) {
            console.log(
              `Actualizando el precio del ramo ${productName} de ${variant.price} a ${precioRamoNuevo}`
            );
            await shopify.productVariant.update(ramo.variants[0].id, {
              price: precioRamoNuevo,
            });
          }
        }
      } catch (updateError) {
        console.error(`Error updating variant ${ramo.variants[0].id}:`);
      }
    });

    await Promise.all(updatePromises);
    return ramosSimples;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}

module.exports = {
  listProducts,
  getProductById,
  getProductMetafields,
  getProductByProductType,
  getProductosFromRamo,
  getRamosByProduct,
  updateRamosSimples,
};
