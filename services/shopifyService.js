const config = require("../utils/config");
const Shopify = require("shopify-api-node");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;
const fs = require("fs");
const { json } = require("express");
const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
  autoLimit: true,
});

async function retryWithBackoff(fn, retries = 10, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (error.response && error.response.statusCode === 429 && retries > 0) {
      // console.log("Rate limited, retrying in", delay, "ms");
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    } else {
      throw error;
    }
  }
}

async function listProducts() {
  return await retryWithBackoff(() => shopify.product.list());
}

async function getProductById(id) {
  return await retryWithBackoff(() => shopify.product.get(id));
}

async function getProductMetafields(productId) {
  return await retryWithBackoff(() =>
    shopify.metafield.list({
      metafield: { owner_resource: "product", owner_id: productId },
    })
  );
}

async function getProductCustomMetafields(productId) {
  return await retryWithBackoff(() =>
    shopify.metafield.list({
      metafield: {
        owner_resource: "product",
        owner_id: productId,
        namespace: "custom",
      },
    })
  );
}

async function getProductByProductType(productType) {
  return await retryWithBackoff(() =>
    shopify.product.list({ product_type: productType })
  );
}

async function getProductosFromProducto(id) {
  try {
    const metafields = await getProductMetafields(id);
    if (!metafields.length) return [];

    const productoIds = [];
    const cantidades = {};

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

        productoIds.push(productoId);
        cantidades[productoId] = cantidad;
      }
    }

    const productos = await Promise.all(
      productoIds.map((productoId) => getProductById(productoId))
    );

    const data_productos = productos
      .filter((producto) => producto) // Filtrar productos no encontrados
      .map((producto) => ({
        producto: {
          id: producto.id,
          title: producto.title,
          product_type: producto.product_type,
          variants: producto.variants,
          options: producto.options,
        },
        cantidad: cantidades[producto.id],
      }));

    return data_productos;
  } catch (error) {
    console.error("Error obteniendo los productos de un ramo", error);
    return [];
  }
}

async function obtenerBundlesContienenProducto(productId, bundleType = null) {
  let bundles = [];
  if (!bundleType) {
    bundles = await listProducts();
  } else {
    bundles = await getProductByProductType(bundleType);
  }

  bundles = await Promise.all(
    bundles.map(async (ramo) => {
      ramo.productos = await getProductosFromProducto(ramo.id);
      return ramo;
    })
  );
  return bundles.filter((ramo) =>
    ramo.productos.some((producto) => producto.producto.id === productId)
  );
}

async function tieneProductos(id) {
  try {
    const metafields = await getProductMetafields(id);
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

async function contenidoEnPaquete(productId, bundleType = null) {
  let bundles = [];
  if (!bundleType) {
    bundles = await listProducts();
  } else {
    bundles = await getProductByProductType(bundleType);
  }
  for (let bundle of bundles) {
    const productosEnRamo = await getProductosFromProducto(bundle.id);
    const productosIds = productosEnRamo.map(
      (producto) => producto.producto.id
    );
    if (productosIds.includes(productId)) {
      return true;
    }
  }
  return false;
}

async function procesarProducto(productId) {
  const id = parseInt(productId, 10);
  const producto = await getProductById(id);
  const bundles = await obtenerBundlesContienenProducto(id);

  bundles.forEach((bundle) => {
    console.log("El producto", producto.title, "está en el ramo", bundle.title);
  });

  // Filtrar bundles simples
  const bundlesSimples = bundles.filter(
    (bundle) =>
      bundle.productos.every(
        (producto) => producto.producto.variants.length === 1
      ) && bundle.variants.length === 1
  );

  const complementoBundlesSimples = bundles.filter(
    (bundle) =>
      !(
        bundle.productos.every(
          (producto) => producto.producto.variants.length === 1
        ) && bundle.variants.length === 1
      )
  );

  // Calcular actualizaciones
  const actualizaciones = bundlesSimples.map(async (bundle) => {
    // Calcular el nuevo precio del ramo
    const precioRamo = bundle.productos
      .reduce((total, producto) => {
        const precioProducto = parseFloat(producto.producto.variants[0].price);
        return total + precioProducto * producto.cantidad;
      }, 0)
      .toFixed(2);

    // Verificar si se requiere actualización
    if (precioRamo !== bundle.variants[0].price) {
      console.log(
        `Actualizado el precio del ramo ${bundle.title} a ${precioRamo} de ${bundle.variants[0].price} a ${precioRamo}`
      );

      // Actualizar precio en Shopify con reintento
      await retryWithBackoff(() =>
        shopify.productVariant.update(bundle.variants[0].id, {
          price: precioRamo,
        })
      );
    }
  });

  // Esperar que todas las actualizaciones se completen
  await Promise.all(actualizaciones);

  // Validar límites de cada bundle
  for (let bundle of complementoBundlesSimples) {
    console.log("_".repeat(50));
    console.log("Validando límites del ramo", bundle.title);
    const valido = bundleValido(bundle);
    if (valido) {
      console.log("El ramo", bundle.title, "es válido");

      // Calcular las variantes
      const { variantes, options } = calcularVariantes(bundle.productos);

      await retryWithBackoff(() =>
        shopify.product.update(bundle.id, { variants: variantes })
      );
    }
    console.log("_".repeat(50));
  }

  return null;
}

function calcularVariantesOpciones(productos) {
  let totalOpciones = 0;
  let totalVariantes = 1;

  productos.forEach((p) => {
    const { producto, cantidad } = p;
    let validOption = true;
    const options = producto.options;

    const numOpciones = producto.options.length;
    if (numOpciones === 1 && options[0].name === "Title") {
      validOption = false;
    }
    const numVariantes = producto.variants.length;

    // Calcula el total de variantes
    totalVariantes *= numVariantes;

    // Suma las opciones
    if (validOption) {
      totalOpciones += numOpciones;
    }
  });

  return { totalOpciones, totalVariantes };
}

function bundleValido(bundle) {
  const productos = bundle.productos;
  const limites = { maxVariantes: 100, maxOpciones: 3 };

  const { totalOpciones, totalVariantes } =
    calcularVariantesOpciones(productos);

  console.log("Total de variantes:", totalVariantes);
  console.log("Total de opciones:", totalOpciones);
  if (totalVariantes > limites.maxVariantes) {
    console.log(
      `El ramo ${bundle.title} supera el límite de variantes (${totalVariantes} > ${limites.maxVariantes})`
    );
    return false;
  }

  if (totalOpciones > limites.maxOpciones) {
    console.log(
      `El ramo ${bundle.title} supera el límite de opciones (${totalOpciones} > ${limites.maxOpciones})`
    );
    return false;
  }

  return true;
}

function calcularVariantes(productos) {
  // Generar las opciones posibles del bundle
  let position = 1;
  let options = [];
  const nameCounts = {};

  const productosOpcionesValidas = productos.filter(
    ({ producto }) =>
      producto.options.length > 1 ||
      (producto.options.length === 1 && producto.options[0].name !== "Title")
  );

  for (const { producto: p } of productosOpcionesValidas) {
    const opciones = p.options.map((option) => {
      const name = option.name;

      // Incrementar el contador para el nombre de la opción
      if (!nameCounts[name]) {
        nameCounts[name] = 0;
      }
      nameCounts[name]++;

      // Crear el nombre de la opción con un sufijo
      const uniqueName = `${name}_${nameCounts[name]}`;

      return {
        position: position++,
        name: uniqueName,
        values: option.values,
      };
    });

    options = [...options, ...opciones];
  }

  // Generar todas las combinaciones de variantes
  const generarCombinaciones = (listas) => {
    if (listas.length === 0) return [[]];
    const resultado = [];
    const [primera, ...resto] = listas;
    const combinacionesRestantes = generarCombinaciones(resto);
    for (const valor of primera) {
      for (const combinacion of combinacionesRestantes) {
        resultado.push([valor, ...combinacion]);
      }
    }
    return resultado;
  };

  // Obtener todas las opciones y variantes de cada producto
  const opcionesPorProducto = productos.map(({ producto }) => {
    return producto.options.length > 1 ||
      (producto.options.length === 1 && producto.options[0].name !== "Title")
      ? producto.variants.map((variant) => variant.title)
      : producto.variants.map(() => null);
  });

  // Obtener combinaciones de variantes
  const combinaciones = generarCombinaciones(opcionesPorProducto);

  // Generar las variantes del bundle
  const variantes = combinaciones.map((combinacion) => {
    const title = combinacion.filter((opcion) => opcion !== null).join(" / ");
    const price = combinacion
      .reduce((total, opcion, index) => {
        const variant =
          opcion !== null
            ? productos[index].producto.variants.find((v) => v.title === opcion)
            : productos[index].producto.variants[0];
        return total + parseFloat(variant.price) * productos[index].cantidad;
      }, 0)
      .toFixed(2);

    // Asignar opciones (option1, option2, option3)
    const opcionesAsignadas = combinacion.filter((opcion) => opcion !== null);
    const [option1, option2, option3] = [
      opcionesAsignadas[0] || null,
      opcionesAsignadas[1] || null,
      opcionesAsignadas[2] || null,
    ];

    return {
      title,
      price,
      option1,
      option2,
      option3,
    };
  });

  return {
    variantes,
    options,
  };
}

module.exports = {
  listProducts,
  getProductById,
  getProductMetafields,
  getProductByProductType,
  getProductosFromProducto,
  obtenerBundlesContienenProducto,
  contenidoEnPaquete,
  tieneProductos,
  getProductCustomMetafields,
  procesarProducto,
};
