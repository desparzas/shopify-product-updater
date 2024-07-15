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
    return [];
  }
}

async function getProductById(id) {
  try {
    const product = await shopify.product.get(id);
    return product;
  } catch (error) {
    return null;
  }
}

async function getProductMetafields(productId) {
  try {
    const metafields = await shopify.metafield.list({
      metafield: { owner_resource: "product", owner_id: productId },
    });
    return metafields;
  } catch (error) {
    return [];
  }
}

async function getProductByProductType(productType) {
  try {
    const products = await shopify.product.list({ product_type: productType });
    return products;
  } catch (error) {
    return [];
  }
}

async function getProductosFromRamo(ramo) {
  try {
    const metafields = await getProductMetafields(ramo.id);
    if (!metafields) {
      console.error("No se encontraron metafields para el ramo ", ramo.id);
      return [];
    }
    const data_productos = [];
    for (let i = 1; i <= 20; i++) {
      let producto = metafields.find(
        (metafield) => metafield.key === `producto_${i}`
      );
      const cantidad = metafields.find(
        (metafield) => metafield.key === `cantidad_del_producto_${i}`
      );
      console.log("Producto: ", producto, " Cantidad: ", cantidad);
      if (producto && cantidad) {
        if (!producto.value) {
          console.error("El metafield no tiene un valor de producto");
          continue;
        }
        if (!cantidad.value) {
          console.error("El metafield no tiene un valor de cantidad");
          continue;
        }
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
    console.log("Error obteniendo los productos de un ramo");
    return [];
  }
}

async function obtenerRamosContienenProducto(productId) {
  try {
    let ramos = await getProductByProductType("Ramo");
    for (let product of ramos) {
      product.productos = await getProductosFromRamo(product);
    }
    ramos = ramos.filter((ramo) => {
      const productos = ramo.productos.map((producto) => producto.producto.id);
      return productos.includes(productId);
    });
    return ramos;
  } catch (error) {
    console.error("Error fetching products:", error);
    return [];
  }
}

async function updateRamosSimples(productId) {
  try {
    console.log("ID del producto recibido: ", productId);
    const product = await getProductById(productId);
    if (!product) {
      console.error(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return [];
    }
    console.log("Producto encontrado: ", product.title);
    const precioNuevo = parseFloat(product.variants[0].price);
    const ramos = await obtenerRamosContienenProducto(productId);

    const ramosSimples = ramos.filter((ramo) => {
      const tieneSoloUnVariant = ramo.productos.every(
        (producto) => producto.producto.variants.length === 1
      );
      return tieneSoloUnVariant && ramo.variants.length === 1;
    });

    if (ramosSimples.length === 0) {
      console.log("No hay ramos simples del producto ", product.title);
      return [];
    }

    console.log(
      "Ramos simples: ",
      ramosSimples.length,
      " del producto ",
      product.title
    );

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
          const productName = ramo.title;
          const variant = ramo.variants[0];
          console.log(
            `Actualizando el precio del ramo ${productName} de ${variant.price} a ${precioRamoNuevo}`
          );
          await shopify.productVariant.update(ramo.variants[0].id, {
            price: precioRamoNuevo,
          });
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
  obtenerRamosContienenProducto,
  updateRamosSimples,
};
