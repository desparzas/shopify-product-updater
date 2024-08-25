const config = require("../utils/config");
const consts = require("../utils/products");
const Shopify = require("shopify-api-node");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;
const fs = require("fs");
const { query } = require("express");
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
  try {
    return retryWithBackoff(async () => {
      const products = await shopify.product.list({ title });
      return products;
    });
  } catch (error) {
    console.error("Error buscando el producto por título", error);
    return [];
  }
}

async function createProduct(product) {
  return retryWithBackoff(async () => {
    return await shopify.product.create(product);
  });
}

async function listProductCustomMetafields(productId) {
  return retryWithBackoff(async () => {
    const metafields = await shopify.metafield.list({
      owner_id: productId,
      owner_resource: "product",
    });
    return metafields;
  });
}

async function iniciarEntorno() {
  const productTypeLatex = "Globo de Látex";
  const productTypeNumerado = "Globo de Número";
  async function iniciarCostos() {
    const costosIds = {};
    const productos = [
      {
        title: "Costo de Mano de Obra",
        product_type: "Costo",
        variants: [
          {
            price: "20.00",
            option1: "Default Title",
            inventory_management: null,
          },
        ],
      },
      {
        title: "Costo del Helio",
        product_type: "Costo",
        variants: [
          {
            price: "25.00",
            option1: "Default Title",
            inventory_management: null,
          },
        ],
      },
    ];

    for (let producto of productos) {
      const product = await searchProductByTitle(producto.title);
      if (product.length) {
        if (producto.title === "Costo de Mano de Obra") {
          costosIds.manoDeObra = product[0].id;
        } else if (producto.title === "Costo del Helio") {
          costosIds.helio = product[0].id;
        }
        console.log("Producto ya existe", producto.title);
      } else {
        console.log("Creando producto", producto.title);
        const product = await createProduct(producto);
        if (product) {
          if (producto.title === "Costo de Mano de Obra") {
            costosIds.manoDeObra = product.id;
          } else if (producto.title === "Costo del Helio") {
            costosIds.helio = product.id;
          }
        }
      }
    }

    return costosIds;
  }
  async function iniciarProductosLatex() {
    const productsDict = {};
    for (let color of consts.coloresGloboLatex) {
      const pTitle = `Globo de Látex Prueba 3 ${color} (Insumo)`;
      const product = await searchProductByTitle(pTitle);

      if (product.length) {
        console.log("Producto ya existe", pTitle);
        // guardar el producto en el diccionario
        productsDict[color] = product[0].id;
        continue;
      } else {
        console.log("Creando producto", pTitle);
        const data = {
          title: pTitle,
          product_type: productTypeLatex,
          variants: [
            {
              price: "1.00",
              option1: "Default Title",
              inventory_management: "shopify",
            },
          ],
        };
        const p = await createProduct(data);
        if (p) {
          productsDict[color] = p.id;
        }
      }
    }
    return productsDict;
  }
  async function iniciarProductosGlobosNumerados() {
    const productsDict = {};
    for (let color of consts.coloresGlobosNumerados) {
      const productTitle = `Globo Numerado Prueba 3 ${color} (Insumo)`;
      const product = await searchProductByTitle(productTitle);

      if (product.length) {
        console.log("Producto ya existe", productTitle);
        // guardar el producto en el diccionario
        productsDict[color] = product[0].id;
        continue;
      }
      try {
        console.log("Creando producto", productTitle);
        let variants = [];
        for (let i = 1; i <= 10; i++) {
          let numAsignado = i;
          if (i === 10) {
            numAsignado = 0;
          }
          variants.push({
            price: "1.00",
            option1: `Globo N°${numAsignado}`,
            inventory_management: "shopify",
          });
        }

        let numeradoCreado = await createProduct({
          title: productTitle,
          product_type: productTypeNumerado,
          variants,
        });

        let numeradoId = -1;
        if (numeradoCreado) {
          numeradoId = numeradoCreado.id;
          console.log("Producto creado", productTitle);
        }

        if (numeradoId !== -1) {
          const newOptionName = "Número";
          const originalOptions = numeradoCreado.options[0];

          const newOptions = {
            id: originalOptions.id,
            product_id: originalOptions.product_id,
            name: newOptionName,
            position: originalOptions.position,
            values: originalOptions.values,
          };

          numeradoCreado.options = [newOptions];

          const updatedProduct = await retryWithBackoff(() => {
            return shopify.product.update(numeradoId, numeradoCreado);
          });

          if (updatedProduct) {
            console.log("Producto actualizado", productTitle);
            productsDict[color] = updatedProduct.id;
          }
        }
      } catch (error) {
        console.log("Error creando el producto", error);
      }
    }

    return productsDict;
  }

  console.log("Iniciando entorno");
  const costosIds = await iniciarCostos();
  const globosLatex = await iniciarProductosLatex();
  const globosNumerados = await iniciarProductosGlobosNumerados();
}

async function createCustomProductTest(product) {
  const { title, price } = product;

  const newProduct = {
    title,
    body_html: "",
    vendor: "Mis Globos",
    product_type: "Ramo Personalizado",
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

async function addDataExtraToProduct(productId, dataExtra) {
  try {
    const metafields = await listProductCustomMetafields(productId);
    const metafield = metafields.find(
      (metafield) => metafield.key === "data_extra"
    );
    if (metafield) {
      await retryWithBackoff(() =>
        shopify.metafield.update(metafield.id, {
          value: JSON.stringify(dataExtra),
        })
      );
    } else {
      await retryWithBackoff(() =>
        shopify.metafield.create({
          namespace: "custom",
          key: "data_extra",
          value: JSON.stringify(dataExtra),
          owner_id: productId,
          owner_resource: "product",
          value_type: "json",
        })
      );
    }
  } catch (error) {
    console.error("Error guardando el data extra en el producto", error);
  }
}

async function searchProductByDataExtra(dataExtra) {
  try {
    const {
      idVariantPrimerNumero,
      idVariantSegundoNumero,
      dataGlobosLatex,
      colorNumero,
    } = dataExtra;

    if (!idVariantPrimerNumero || !idVariantSegundoNumero || !dataGlobosLatex) {
      throw new Error("Data extra incompleta");
    }

    const idsGlobosLatex = Object.values(dataGlobosLatex).map(
      (globo) => globo.id
    );

    console.log("IDs Globos Látex:", idsGlobosLatex);

    const ramosPersonalizados = await getProductByProductType(
      "Ramo Personalizado"
    );

    for (const ramo of ramosPersonalizados) {
      const metafields = await getProductCustomMetafields(ramo.id);
      const metafield = metafields.find((mf) => mf.key === "data_extra");

      if (metafield) {
        const data = JSON.parse(metafield.value);
        console.log("Data desde función", data);

        const {
          idVariantPrimerNumero: varPrimG,
          idVariantSegundoNumero: varSegG,
          dataGlobosLatex: dataLatexG,
          colorNumero: colorNumeroG,
        } = data;

        const idsG = Object.values(dataLatexG).map((globo) => globo.id);

        console.log("IDs desde Metafields:", idsG);

        const isValid =
          varPrimG === idVariantPrimerNumero &&
          varSegG === idVariantSegundoNumero &&
          idsG.every((id) => idsGlobosLatex.includes(id)) &&
          colorNumeroG === colorNumero &&
          idsG.length === idsGlobosLatex.length;

        if (isValid) {
          return [ramo];
        }
      }
    }
    return [];
  } catch (error) {
    console.error("Error buscando productos por data extra:", error);
  }
}

async function listProducts() {
  let allProducts = [];
  let params = {
    limit: 50,
    fields: ["id", "title", "product_type", "variants", "options"],
    order: "id asc",
  };

  console.log("Obteniendo productos...");
  let hasMoreProducts = true;

  do {
    // obtener los products ordenados de 10 en 10 ordenados por id
    let products = await retryWithBackoff(() => {
      return shopify.product.list(params);
    });

    // ordenar los productos por id
    products = products.sort((a, b) => a.id - b.id);
    allProducts = allProducts.concat(products);

    if (products.length < params.limit) {
      hasMoreProducts = false;
    } else {
      params.since_id = products[products.length - 1].id;
    }
  } while (hasMoreProducts);

  return allProducts;
}

async function getProductById(id) {
  return retryWithBackoff(async () => {
    return await shopify.product.get(id);
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

function isDefaultOption(options) {
  if (options.length !== 1) return false;
  const option = options[0];
  const { name, values } = option;
  return (
    name === "Title" && values.length === 1 && values[0] === "Default Title"
  );
}

function isSimpleProduct(product) {
  return product.variants.length === 1 && isDefaultOption(product.options);
}

async function getBundlesWithProduct(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función getBundlesWithProduct"
      );
      return;
    }

    let products = await listProducts();

    console.log("Productos obtenidos:", products.length);

    for (const product of products) {
      const metafields = await getProductCustomMetafields(product.id);
      product.metafields = metafields;
    }

    // filtrar a los productos que tengan metafields y que tengan el key "lista_de_productos" en el namespace "custom"
    let bundles = products.filter((product) => {
      return (
        product.metafields.length > 0 &&
        product.metafields.some(
          (metafield) =>
            metafield.key === "lista_de_productos" &&
            metafield.namespace === "custom"
        )
      );
    });

    // filtrar a los productos que tengan el producto en su lista de productos
    bundles = bundles.filter((bundle) => {
      // console.log("Buscando en el bundle", bundle.title);
      const metafield = bundle.metafields.find(
        (metafield) => metafield.key === "lista_de_productos"
      );
      let listaProductos = JSON.parse(metafield.value);
      const t = listaProductos.some((producto) => {
        const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
        return id === productId;
      });
      // console.log("Lista de productos:", t);
      return t;
    });

    // convertir la lista de productos a un arreglo de productos, buscando el producto en la lista de productos

    bundles = bundles.map((bundle) => {
      const { metafields } = bundle;
      const listaProductosMetafield = metafields.find(
        (metafield) =>
          metafield.key === "lista_de_productos" &&
          metafield.namespace === "custom"
      );

      const listaCantidadMetafield = metafields.find(
        (metafield) =>
          metafield.key === "lista_de_cantidad" &&
          metafield.namespace === "custom"
      );

      let listaProductos = JSON.parse(listaProductosMetafield.value);
      listaProductos = listaProductos.map((producto) => {
        const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
        return products.find((product) => product.id === id);
      });

      let listaCantidad;

      if (listaCantidadMetafield) {
        listaCantidad = JSON.parse(listaCantidadMetafield.value);
        listaCantidad = listaCantidad.map((cantidad) => parseFloat(cantidad));
        if (listaCantidad.length !== listaProductos.length) {
          listaCantidad = Array(listaProductos.length).fill(1);
        }
      } else {
        listaCantidad = Array(listaProductos.length).fill(1);
      }

      return {
        ...bundle,
        productos: listaProductos,
        cantidades: listaCantidad,
      };
    });

    console.log("Bundles obtenidos:", bundles.length);

    return bundles;
  } catch (error) {
    console.error("Error obteniendo los bundles con el producto", error);
    return [];
  }
}

async function actualizarBundlesDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      throw new Error(
        "Producto no encontrado en la base de datos desde la función updateBundles"
      );
    }
    console.log("Actualizando bundles del producto ", product.title);
    const bundles = await getBundlesWithProduct(id);
    fs.writeFileSync(
      "./test/bundlesHelios.json",
      JSON.stringify(bundles, null, 2)
    );
    for (const bundle of bundles) {
      console.log("_".repeat(50));
      console.log("Actualizando el bundle", bundle.title);

      const { options, variants, metafields, productos, cantidades } = bundle;

      if (isSimpleProduct(bundle)) {
        console.log("El bundle es un producto simple");
        const precioActual = variants[0].price;
        let precioTotal = 0;

        for (let i = 0; i < productos.length; i++) {
          const producto = productos[i];
          const cantidad = cantidades[i];
          const precio = producto.variants[0].price;
          precioTotal += cantidad * precio;
        }

        console.log("ACTUAL - NUEVO", precioActual, precioTotal);

        if (precioTotal !== precioActual) {
          console.log("Actualizando el precio del bundle");
          await retryWithBackoff(() => {
            return shopify.productVariant.update(variants[0].id, {
              price: precioTotal,
            });
          });
        }
      } else {
        const { variants, options } = bundle;
        if (options.length === 1) {
          console.log("El bundle tiene una opción");
        } else if (options.length === 2) {
          console.log("El bundle tiene dos opciones");
        } else if (options.length === 3) {
          console.log("El bundle tiene tres opciones");
        }
      }

      console.log("_".repeat(50));
    }

    fs.writeFileSync("./test/bundles.json", JSON.stringify(bundles, null, 2));
  } catch (error) {
    console.log("Error actualizando bundles: ", error);
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

async function getVariant(variantId) {
  try {
    const variant = await retryWithBackoff(() => {
      return shopify.productVariant.get(variantId);
    });
    return variant;
  } catch (error) {
    console.error("Error obteniendo el variant:", error);
    return null;
  }
}

async function getInventoryLevels(inventoryItemId) {
  try {
    const inventoryLevels = await retryWithBackoff(() => {
      return shopify.inventoryLevel.list({
        inventory_item_ids: inventoryItemId,
      });
    });
    return inventoryLevels;
  } catch (error) {
    console.error("Error obteniendo los niveles de inventario:", error);
    return null;
  }
}

async function reducirInventario(variantId, quantityToReduce) {
  try {
    const variant = await getVariant(variantId);

    if (!variant.inventory_management) {
      console.log("El producto no tiene inventario");
      return;
    }
    const inventoryItemId = variant.inventory_item_id;

    const inventoryLevels = await getInventoryLevels(inventoryItemId);

    const index = inventoryLevels.findIndex(
      (inventoryLevel) => inventoryLevel.available > 0
    );

    if (index === -1) {
      // disminuir el inventario del primer nivel
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[0].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[0].available - quantityToReduce,
        });
      });
    } else {
      // disminuir el inventario del nivel que tenga inventario
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[index].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[index].available - quantityToReduce,
        });
      });
    }
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
  }
}

module.exports = {
  listProducts,
  getProductById,
  getProductCustomMetafields,
  getProductByProductType,
  obtenerBundlesContienenProducto,
  contenidoEnPaquete,
  createCustomProductTest,
  searchProductByTitle,
  actualizarVarianteProducto,
  reducirInventario,
  getVariant,
  iniciarEntorno,
  listProductCustomMetafields,
  addDataExtraToProduct,
  searchProductByDataExtra,
  actualizarBundlesDeProducto,
};
