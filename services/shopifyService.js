const config = require("../utils/config");
const Shopify = require("shopify-api-node");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;
const fs = require("fs");
const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
});

async function retryWithBackoff(fn, retries = 10, delay = 1000) {
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

async function searchProductByTitle(title) {
  return retryWithBackoff(async () => {
    const products = await shopify.product.list({ title });
    return products;
  });
}

async function createProduct(product) {
  const { title, price } = product;

  const newProduct = {
    title,
    body_html: "",
    vendor: "Mis Globos",
    product_type: "Ramo Creado",
    variants: [
      {
        price,
        option1: "Default Title",
      },
    ],
  };

  return retryWithBackoff(async () => {
    return await shopify.product.create(newProduct);
  });
}

async function actualizarVarianteProducto(productoId, variantId, price) {
  return retryWithBackoff(async () => {
    return await shopify.productVariant.update(variantId, { price });
  });
}

async function listProducts() {
  return retryWithBackoff(async () => {
    const products = await shopify.product.list();
    for (let product of products) {
      product.metafields = await getProductCustomMetafields(product.id);
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

async function getProductCustomMetafields(productId) {
  return retryWithBackoff(async () => {
    return await shopify.metafield.list({
      metafield: {
        owner_resource: "product",
        owner_id: productId,
        namespace: "custom",
      },
    });
  });
}

async function getProductByProductType(productType) {
  return retryWithBackoff(async () => {
    return await shopify.product.list({ product_type: productType });
  });
}

async function getProductosFromProducto(id) {
  try {
    const metafields = await getProductMetafields(id);
    if (!metafields.length) return [];

    const data_productos = [];
    for (let i = 1; i <= 20; i++) {
      const productoMetafield = metafields.find(
        (metafield) => metafield.key === `producto_${i}` && metafield.value
      );
      const cantidadMetafield = metafields.find(
        (metafield) =>
          metafield.key === `cantidad_del_producto_${i}` && metafield.value
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
    console.error("Error obteniendo los productos de un ramo", error);
    return [];
  }
}

async function obtenerBundlesContienenProducto(productId, bundleType) {
  return retryWithBackoff(async () => {
    let ramos = await getProductByProductType(bundleType);
    ramos = await Promise.all(
      ramos.map(async (ramo) => {
        ramo.productos = await getProductosFromProducto(ramo.id);
        return ramo;
      })
    );
    return ramos.filter((ramo) =>
      ramo.productos.some((producto) => producto.producto.id === productId)
    );
  });
}

async function tieneProductos(id) {
  try {
    const metafields = await getProductMetafields(id);
    // console.log("Metafields", metafields);

    if (!metafields.length) return false;

    for (let i = 1; i <= 20; i++) {
      const productoMetafield = metafields.find(
        (metafield) => metafield.key === `producto_${i}` && metafield.value
      );
      const cantidadMetafield = metafields.find(
        (metafield) =>
          metafield.key === `cantidad_del_producto_${i}` && metafield.value
      );

      if (productoMetafield && cantidadMetafield) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error(
      "Error verificando si el producto contiene otros productos",
      error
    );
    return false;
  }
}

async function actualizarRamosSimplesDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return;
    }
    const precioNuevo = parseFloat(product.variants[0].price);
    const ramos = await obtenerBundlesContienenProducto(id, "Ramo Simple");
    const ramosSimples = ramos.filter((ramo) => {
      return (
        ramo.productos.every(
          (producto) => producto.producto.variants.length === 1
        ) && ramo.variants.length === 1
      );
    });

    const actualizaciones = ramosSimples.map(async (ramo) => {
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

        await retryWithBackoff(() =>
          shopify.productVariant.update(ramo.variants[0].id, {
            price: precioRamoNuevo,
          })
        );
      }
    });

    await Promise.all(actualizaciones);

    console.log("Ramos simples actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando ramos simples: ", error);
  }
}

async function actualizarGlobosNumeradosDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return;
    }
    const globosNumerados = await obtenerBundlesContienenProducto(
      id,
      "Globo de Número"
    );

    const actualizaciones = globosNumerados.map(async (globo) => {
      let variantsTemp = JSON.parse(JSON.stringify(globo.variants));
      const posibleOptions = [];
      for (let variant of variantsTemp) {
        const option1 = variant.option1;
        if (!posibleOptions.includes(option1)) {
          const formatted = option1.replace("Globo N°", "");
          posibleOptions.push(formatted);
        }
      }

      const productoGlobo = globo.productos.find(
        (producto) => producto.producto.product_type === "Globo de Número"
      );

      const simples = globo.productos.filter(
        (producto) => producto.producto.variants.length === 1
      );
      let sumaSimples = 0;
      for (let simple of simples) {
        sumaSimples +=
          parseFloat(simple.producto.variants[0].price) * simple.cantidad;
      }

      let variantsUpdated = false;
      for (let i of posibleOptions) {
        const variantTemp = variantsTemp.find(
          (variant) => variant.option1 === `Globo N°${i}`
        );
        const index = variantsTemp.indexOf(variantTemp);
        const variant = globo.variants.find(
          (variant) => variant.option1 === `Globo N°${i}`
        );

        const unitVariant = productoGlobo.producto.variants.find(
          (variant) => variant.option1 === `Globo N°${i}`
        );

        if (variant.price !== sumaSimples + parseFloat(unitVariant.price)) {
          const precioNuevo = sumaSimples + parseFloat(unitVariant.price);
          const precioNuevoString = precioNuevo.toFixed(2);
          variantsTemp[index].price = precioNuevoString;
          variantsUpdated = true;
        }
      }

      if (variantsUpdated) {
        await retryWithBackoff(() =>
          shopify.product.update(globo.id, { variants: variantsTemp })
        );
      }
    });

    await Promise.all(actualizaciones);

    console.log("Globos numerados actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando globos numerados: ", error);
  }
}

async function actualizarRamosDoblesNumeradosDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return;
    }
    const ramosDoblesNumerados = await obtenerBundlesContienenProducto(
      id,
      "Ramo Doble Numerado"
    );

    const actualizaciones = ramosDoblesNumerados.map(async (globo) => {
      let variantsTemp = JSON.parse(JSON.stringify(globo.variants));
      const posibleOptions = [];

      for (let variant of variantsTemp) {
        const option1 = variant.option1;
        const option2 = variant.option2;
        const combinedOptions = `${option1}-${option2}`;
        if (!posibleOptions.includes(combinedOptions)) {
          const formattedOption1 = option1.replace("Globo N°", "");
          const formattedOption2 = option2.replace("Globo N°", "");
          posibleOptions.push({
            option1: formattedOption1,
            option2: formattedOption2,
          });
        }
      }

      const productoGlobo = globo.productos.find(
        (producto) => producto.producto.product_type === "Globo de Número"
      );

      const simples = globo.productos.filter(
        (producto) => producto.producto.variants.length === 1
      );
      let sumaSimples = 0;
      for (let simple of simples) {
        sumaSimples +=
          parseFloat(simple.producto.variants[0].price) * simple.cantidad;
      }

      let variantsUpdated = false;
      for (let options of posibleOptions) {
        const { option1, option2 } = options;
        const variantTemp = variantsTemp.find(
          (variant) =>
            variant.option1 === `Globo N°${option1}` &&
            variant.option2 === `Globo N°${option2}`
        );
        const index = variantsTemp.indexOf(variantTemp);
        const variant = globo.variants.find(
          (variant) =>
            variant.option1 === `Globo N°${option1}` &&
            variant.option2 === `Globo N°${option2}`
        );

        const unitVariant1 = productoGlobo.producto.variants.find(
          (variant) => variant.option1 === `Globo N°${option1}`
        );
        const unitVariant2 = productoGlobo.producto.variants.find(
          (variant) => variant.option1 === `Globo N°${option2}`
        );

        const nuevoPrecio =
          sumaSimples +
          parseFloat(unitVariant1.price) +
          parseFloat(unitVariant2.price);

        const nuevoPrecioString = nuevoPrecio.toFixed(2);

        if (variant.price !== nuevoPrecioString) {
          variantsTemp[index].price = nuevoPrecioString;
          variantsUpdated = true;
        }
      }
      if (variantsUpdated) {
        await retryWithBackoff(() =>
          shopify.product.update(globo.id, { variants: variantsTemp })
        );
      }
    });

    await Promise.all(actualizaciones);

    console.log("Globos numerados actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando globos numerados: ", error);
  }
}

async function contenidoEnPaquete(productId, bundleType) {
  return retryWithBackoff(async () => {
    const ramos = await getProductByProductType(bundleType);
    for (let ramo of ramos) {
      // console.log("Buscando en el ramo", ramo.title);
      const productosEnRamo = await getProductosFromProducto(ramo.id);
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

async function actualizarInventario(productId, inventory) {
  return retryWithBackoff(async () => {
    return await shopify.productVariant.update(productId, {
      inventory_quantity: inventory,
    });
  });
}

module.exports = {
  listProducts,
  getProductById,
  getProductMetafields,
  getProductByProductType,
  getProductosFromProducto,
  obtenerBundlesContienenProducto,
  actualizarRamosSimplesDeProducto,
  contenidoEnPaquete,
  actualizarGlobosNumeradosDeProducto,
  tieneProductos,
  getProductCustomMetafields,
  actualizarRamosDoblesNumeradosDeProducto,
  createProduct,
  searchProductByTitle,
  actualizarVarianteProducto,
  actualizarInventario,
};
