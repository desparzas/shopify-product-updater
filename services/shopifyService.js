const config = require("../utils/config");
const consts = require("../utils/products");
const Shopify = require("shopify-api-node");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;
const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
});

const productCache = new Map();
const bundlesCache = new Map();

async function retryWithBackoff(fn, retries = 10, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    if (error.response && error.response.statusCode === 429 && retries > 0) {
      // console.log(`Rate limit hit, retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    } else {
      throw error;
    }
  }
}

async function actualizarVarianteProducto(variantId, price) {
  return await shopify.productVariant.update(variantId, { price });
}

async function productCount() {
  return retryWithBackoff(async () => {
    return await shopify.product.count();
  });
}

async function loadCache() {
  if (productCache.size === 0) {
    console.log("Cargando caché de productos...");
    let allProducts = [];
    let params = {
      limit: 250,
      fields: ["id", "title", "product_type", "variants", "options"],
      order: "id asc",
    };

    let hasMoreProducts = true;

    do {
      let products = await retryWithBackoff(() => {
        return shopify.product.list(params);
      });

      products = products.sort((a, b) => a.id - b.id);
      allProducts = allProducts.concat(products);

      // Agregar productos al caché
      products.forEach((product) => {
        addToProductCache(product);
      });

      if (products.length < params.limit) {
        hasMoreProducts = false;
      } else {
        params.since_id = products[products.length - 1].id;
      }
    } while (hasMoreProducts);

    console.log("Caché cargado con", productCache.size, "productos.");

    // await buildBundlesCache();

    console.log("Caché de bundles creado con", bundlesCache.size, "bundles.");
  } else {
    console.log("El caché de productos ya está cargado.");
  }
}

async function obtenerProductosCantidades(productoId) {
  const metafields = await getProductCustomMetafields(productoId);

  const listaProductosMetafield = metafields.find(
    (metafield) =>
      metafield.key === "lista_de_productos" && metafield.namespace === "custom"
  );

  if (!listaProductosMetafield) {
    return [];
  }

  const listaCantidadMetafield = metafields.find(
    (metafield) =>
      metafield.key === "lista_de_cantidad" && metafield.namespace === "custom"
  );

  let listaProductos = JSON.parse(listaProductosMetafield.value).map(
    (producto) => {
      const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
      return productCache.get(id);
    }
  );

  const listaCantidad = listaCantidadMetafield
    ? JSON.parse(listaCantidadMetafield.value).map((cantidad) =>
        parseFloat(cantidad)
      )
    : Array(listaProductos.length).fill(1);

  if (listaCantidad.length !== listaProductos.length) {
    listaCantidad.fill(1, listaCantidad.length, listaProductos.length);
  }

  return listaProductos.map((producto, index) => ({
    producto,
    cantidad: listaCantidad[index],
  }));
}

async function buildBundlesCache() {
  if (productCache.size === 0) {
    console.log("No se puede construir el caché de bundles sin productos.");
    return;
  }

  const bundlesToCache = [];

  const keys = Array.from(productCache.keys());

  // Itera sobre cada producto en el caché principal de productos
  for (const key of keys) {
    const metafields = await getProductCustomMetafields(key);

    if (!metafields) {
      continue;
    }

    const listaProductosMetafield = metafields.find(
      (metafield) =>
        metafield.key === "lista_de_productos" &&
        metafield.namespace === "custom"
    );

    if (listaProductosMetafield) {
      const listaCantidadMetafield = metafields.find(
        (metafield) =>
          metafield.key === "lista_de_cantidad" &&
          metafield.namespace === "custom"
      );

      let listaProductos = JSON.parse(listaProductosMetafield.value).map(
        (producto) => {
          const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
          return id;
        }
      );

      const listaCantidad = listaCantidadMetafield
        ? JSON.parse(listaCantidadMetafield.value).map((cantidad) =>
            parseFloat(cantidad)
          )
        : Array(listaProductos.length).fill(1);

      if (listaCantidad.length !== listaProductos.length) {
        listaCantidad.fill(1, listaCantidad.length, listaProductos.length);
      }

      bundlesToCache.push({
        id: key,
        productos: listaProductos,
        cantidades: listaCantidad,
      });
    }
  }

  for (const bundle of bundlesToCache) {
    bundlesCache.set(bundle.id, {
      productos: bundle.productos,
      cantidades: bundle.cantidades,
    });
  }

  console.log("Caché de bundles creado con", bundlesCache.size, "bundles.");
}

async function listProducts() {
  await loadCache();
  return Array.from(productCache.values());
}

async function getProductById(id) {
  if (productCache.has(id)) {
    console.log(`Producto ${id} encontrado en el caché.`);
    return productCache.get(id);
  }

  const product = await retryWithBackoff(async () => {
    return await shopify.product.get(id);
  });

  addToProductCache(product);

  console.log(`Producto ${id} obtenido de Shopify y añadido al caché.`);
  return product;
}

async function processProduct(product) {
  if (productCache.has(product.id)) {
    updateProductInCache(product);
    await updateBundleToCache(product);
  } else {
    addToProductCache(product);
    await addBundleInCache(product);
  }
}

async function addBundleInCache(product) {
  const metafields = await getProductCustomMetafields(product.id);

  if (!metafields) {
    return;
  }

  const listaProductosMetafield = metafields.find(
    (metafield) =>
      metafield.key === "lista_de_productos" && metafield.namespace === "custom"
  );

  if (!listaProductosMetafield) {
    return;
  }

  const listaCantidadMetafield = metafields.find(
    (metafield) =>
      metafield.key === "lista_de_cantidad" && metafield.namespace === "custom"
  );

  let listaProductos = JSON.parse(listaProductosMetafield.value).map(
    (producto) => {
      const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
      return id;
    }
  );

  const listaCantidad = listaCantidadMetafield
    ? JSON.parse(listaCantidadMetafield.value).map((cantidad) =>
        parseFloat(cantidad)
      )
    : Array(listaProductos.length).fill(1);

  if (listaCantidad.length !== listaProductos.length) {
    listaCantidad.fill(1, listaCantidad.length, listaProductos.length);
  }

  bundlesCache.set(product.id, {
    productos: listaProductos,
    cantidades: listaCantidad,
  });
}

async function updateBundleToCache(product) {
  const metafields = await getProductCustomMetafields(product.id);

  if (!metafields) {
    // eliminar bundle
    bundlesCache.delete(product.id);
    return;
  }

  const listaProductosMetafield = metafields.find(
    (metafield) =>
      metafield.key === "lista_de_productos" && metafield.namespace === "custom"
  );

  if (!listaProductosMetafield) {
    // eliminar bundle
    bundlesCache.delete(product.id);
    return;
  }

  const listaCantidadMetafield = metafields.find(
    (metafield) =>
      metafield.key === "lista_de_cantidad" && metafield.namespace === "custom"
  );

  let listaProductos = JSON.parse(listaProductosMetafield.value).map(
    (producto) => {
      const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
      return id;
    }
  );

  const listaCantidad = listaCantidadMetafield
    ? JSON.parse(listaCantidadMetafield.value).map((cantidad) =>
        parseFloat(cantidad)
      )
    : Array(listaProductos.length).fill(1);

  if (listaCantidad.length !== listaProductos.length) {
    listaCantidad.fill(1, listaCantidad.length, listaProductos.length);
  }

  bundlesCache.set(product.id, {
    productos: listaProductos,
    cantidades: listaCantidad,
  });

  console.log("Bundle actualizado en el caché.");
}

function addToProductCache(product) {
  productCache.set(product.id, product);
}

function updateProductInCache(product) {
  productCache.set(product.id, product);
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

function getBundlesWithProduct(productId) {
  try {
    const id = parseInt(productId, 10);
    const filteredBundles = new Map();
    for (const [bundleId, bundle] of bundlesCache.entries()) {
      const productos = bundle.productos;
      const cantidades = bundle.cantidades;
      const index = productos.indexOf(id);
      if (index !== -1) {
        filteredBundles.set(bundleId, {
          productos: productos,
          cantidades: cantidades,
        });
      }
    }
    return filteredBundles;
  } catch (error) {
    console.error("Error obteniendo los bundles con el producto", error);
    return new Map();
  }
}

async function updateProductVariants(productId, variants) {
  return await shopify.product.update(productId, { variants });
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

async function actualizarBundlesDeProducto(productData) {
  try {
    await loadCache();
    await processProduct(productData);
    console.log("Actualizando bundles del producto ", productData.title);
    const bundlesList = getBundlesWithProduct(productData.id);

    const bundleUpdatePromises = [];

    console.log("Bundles encontrados:", bundlesList.size);

    for (const [bundleId, bundle] of bundlesList.entries()) {
      const productos = bundle.productos.map((id) => productCache.get(id));
      const cantidades = bundle.cantidades;

      const bundleProduct = productCache.get(bundleId);
      const variants = bundleProduct.variants;
      const options = bundleProduct.options;

      let variantsTemp = JSON.parse(JSON.stringify(variants));
      let actualizarPrecio = false;
      if (isSimpleProduct(bundleProduct)) {
        const precioActual = variants[0].price;
        let precioTotal = 0;

        for (let i = 0; i < productos.length; i++) {
          const producto = productos[i];
          const cantidad = cantidades[i];
          const precio = producto.variants[0].price;
          precioTotal += cantidad * precio;
        }

        const precioTotalString = precioTotal.toFixed(2);

        if (precioTotalString != precioActual) {
          variantsTemp[0].price = precioTotalString;
          console.log(
            "Actualizando ",
            bundleProduct.title,
            ":",
            precioActual,
            "-->",
            precioTotalString
          );
          actualizarPrecio = true;
        }

        if (actualizarPrecio) {
          bundleUpdatePromises.push(() =>
            updateProductVariants(bundleId, variantsTemp)
          );
        }
      } else {
        if (options.length === 1) {
          console.log("_".repeat(50));
          console.log("El bundle ", bundleProduct.title, "tiene una opción.");
          const preciosPrimerasVariantes = productos.map(
            (producto) => producto.variants[0].price
          );

          for (let j = 0; j < variants.length; j++) {
            const variant = variants[j];
            const { option1 } = variant;
            const precioVariant = variant.price;

            const productoDeterminaVariante = productos.find((p) =>
              p.variants.some((v) => v.option1 === option1)
            );

            if (!productoDeterminaVariante) {
              continue;
            }

            const variantsProductoDeterminaVariante =
              productoDeterminaVariante.variants;

            const precioDeterminaVariante =
              variantsProductoDeterminaVariante.find(
                (v) => v.option1 === option1
              ).price;

            const varianteDeterminaPrecio = variantsTemp.find(
              (v) => v.option1 === option1
            );

            let precioTotal = 0;

            for (let i = 0; i < productos.length; i++) {
              const producto = productos[i];
              const cantidad = cantidades[i];
              const precioPrimerVariante = preciosPrimerasVariantes[i];

              if (producto.id === productoDeterminaVariante.id) {
                precioTotal += cantidad * precioDeterminaVariante;
              } else {
                precioTotal += cantidad * precioPrimerVariante;
              }
            }

            const precioTotalString = precioTotal.toFixed(2);

            if (precioVariant != precioTotalString) {
              console.log(
                "Actualizando precio de",
                bundleProduct.title,
                "para la opción",
                option1,
                ":",
                precioVariant,
                "-->",
                precioTotal
              );
              actualizarPrecio = true;
              variantsTemp[j].price = precioTotalString;
            }
          }

          if (actualizarPrecio) {
            bundleUpdatePromises.push(() =>
              updateProductVariants(bundleId, variantsTemp)
            );
          }
          console.log("_".repeat(50));
        } else {
          if (options.length === 2) {
            console.log("_".repeat(50));
            console.log(
              "El bundle ",
              bundleProduct.title,
              "tiene dos opciones."
            );
            const preciosPrimerasVariantes = productos.map(
              (producto) => producto.variants[0].price
            );

            for (let j = 0; j < variants.length; j++) {
              const variant = variants[j];
              const { option1, option2 } = variant;

              const precioVariant = variant.price;

              const productoDeterminaVariante = productos.find((p) =>
                p.variants.some(
                  (v) => v.option1 === option1 && v.option2 === option2
                )
              );

              if (productoDeterminaVariante) {
                const variantsProductoDeterminaVariante =
                  productoDeterminaVariante.variants;

                const precioDeterminaVariante =
                  variantsProductoDeterminaVariante.find(
                    (v) => v.option1 === option1 && v.option2 === option2
                  ).price;

                let precioTotal = 0;

                for (let i = 0; i < productos.length; i++) {
                  const producto = productos[i];
                  const cantidad = cantidades[i];
                  const precioPrimerVariante = preciosPrimerasVariantes[i];

                  if (producto.id === productoDeterminaVariante.id) {
                    precioTotal += cantidad * precioDeterminaVariante;
                  } else {
                    precioTotal += cantidad * precioPrimerVariante;
                  }
                }

                const precioTotalString = precioTotal.toFixed(2);

                if (precioVariant != precioTotalString) {
                  console.log(
                    "Actualizando precio de",
                    bundleProduct.title,
                    "para la opción",
                    option1,
                    option2,
                    ":",
                    precioVariant,
                    "-->",
                    precioTotal
                  );
                  actualizarPrecio = true;
                  variantsTemp[j].price = precioTotalString;
                }
              } else {
                const producto1 = productos.find((p) =>
                  p.variants.some((v) => v.option1 === option1)
                );

                const producto2 = productos.find((p) =>
                  p.variants.some((v) => v.option1 === option2)
                );

                if (!producto1 || !producto2) {
                  break;
                }

                const variantsProducto1 = producto1.variants;
                const variantsProducto2 = producto2.variants;

                const precioProducto1 = variantsProducto1.find(
                  (v) => v.option1 === option1
                ).price;

                const precioProducto2 = variantsProducto2.find(
                  (v) => v.option1 === option2
                ).price;

                let precioTotal = 0;

                for (let i = 0; i < productos.length; i++) {
                  const producto = productos[i];
                  const cantidad = cantidades[i];
                  const precioPrimerVariante = preciosPrimerasVariantes[i];

                  if (producto.id === producto1.id) {
                    precioTotal += cantidad * precioProducto1;
                  } else if (producto.id === producto2.id) {
                    precioTotal += cantidad * precioProducto2;
                  } else {
                    precioTotal += cantidad * precioPrimerVariante;
                  }
                }

                const precioTotalString = precioTotal.toFixed(2);

                if (precioVariant != precioTotalString) {
                  console.log(
                    "Actualizando precio de",
                    bundleProduct.title,
                    "para la opción",
                    option1,
                    option2,
                    ":",
                    precioVariant,
                    "-->",
                    precioTotal
                  );
                  actualizarPrecio = true;
                  variantsTemp[j].price = precioTotalString;
                }
              }
            }

            if (actualizarPrecio) {
              console.log("Actualizando bundle...");
              bundleUpdatePromises.push(() =>
                updateProductVariants(bundleId, variantsTemp)
              );
            }

            console.log("_".repeat(50));
          } else {
            if (options.length === 3) {
              console.log("_".repeat(50));
              console.log(
                "El bundle ",
                bundleProduct.title,
                "tiene tres opciones."
              );
              const preciosPrimerasVariantes = productos.map(
                (producto) => producto.variants[0].price
              );

              for (let j = 0; j < variants.length; j++) {
                const variant = variants[j];

                const { option1, option2, option3 } = variant;
                console.log("Opciones:", option1, option2, option3);

                const productoDetermina3Variante = productos.find((p) =>
                  p.variants.some(
                    (v) =>
                      v.option1 === option1 &&
                      v.option2 === option2 &&
                      v.option3 === option3
                  )
                );

                if (productoDetermina3Variante) {
                  const variantsProductoDetermina3Variante =
                    productoDetermina3Variante.variants;

                  const precioDetermina3Variante =
                    variantsProductoDetermina3Variante.find(
                      (v) =>
                        v.option1 === option1 &&
                        v.option2 === option2 &&
                        v.option3 === option3
                    ).price;

                  let precioTotal = 0;

                  for (let i = 0; i < productos.length; i++) {
                    const producto = productos[i];
                    const cantidad = cantidades[i];
                    const precioPrimerVariante = preciosPrimerasVariantes[i];

                    if (producto.id === productoDetermina3Variante.id) {
                      precioTotal += cantidad * precioDetermina3Variante;
                    } else {
                      precioTotal += cantidad * precioPrimerVariante;
                    }
                  }

                  const precioTotalString = precioTotal.toFixed(2);

                  if (variant.price != precioTotalString) {
                    console.log(
                      "Actualizando precio de",
                      bundleProduct.title,
                      "para la opción",
                      option1,
                      option2,
                      option3,
                      ":",
                      variant.price,
                      "-->",
                      precioTotal
                    );
                    actualizarPrecio = true;
                    variantsTemp[j].price = precioTotalString;
                  }
                } else {
                  const productoDetermina2Variante = productos.find((p) =>
                    p.variants.some(
                      (v) => v.option1 === option1 && v.option2 === option2
                    )
                  );

                  const productoDetermina1Variante = productos.find((p) =>
                    p.variants.some((v) => v.option1 === option3)
                  );

                  if (
                    productoDetermina2Variante &&
                    productoDetermina1Variante
                  ) {
                    const variantsProductoDetermina2Variante =
                      productoDetermina2Variante.variants;
                    const variantsProductoDetermina1Variante =
                      productoDetermina1Variante.variants;

                    const precioDetermina2Variante =
                      variantsProductoDetermina2Variante.find(
                        (v) => v.option1 === option1 && v.option2 === option2
                      ).price;

                    const precioDetermina1Variante =
                      variantsProductoDetermina1Variante.find(
                        (v) => v.option1 === option3
                      ).price;

                    let precioTotal = 0;

                    for (let i = 0; i < productos.length; i++) {
                      const producto = productos[i];
                      const cantidad = cantidades[i];
                      const precioPrimerVariante = preciosPrimerasVariantes[i];

                      if (producto.id === productoDetermina2Variante.id) {
                        precioTotal += cantidad * precioDetermina2Variante;
                      } else if (
                        producto.id === productoDetermina1Variante.id
                      ) {
                        precioTotal += cantidad * precioDetermina1Variante;
                      } else {
                        precioTotal += cantidad * precioPrimerVariante;
                      }
                    }

                    const precioTotalString = precioTotal.toFixed(2);

                    if (variant.price != precioTotalString) {
                      console.log(
                        "Actualizando precio de",
                        bundleProduct.title,
                        "para la opción",
                        option1,
                        option2,
                        option3,
                        ":",
                        variant.price,
                        "-->",
                        precioTotal
                      );
                      actualizarPrecio = true;
                      variantsTemp[j].price = precioTotalString;
                    }
                  } else {
                    const productoDetermina1VarianteAlt = productos.find((p) =>
                      p.variants.some(
                        (v) => v.option1 === option1 && v.option2 === option3
                      )
                    );

                    const productoDetermina2VarianteAlt = productos.find((p) =>
                      p.variants.some((v) => v.option1 === option2)
                    );

                    if (
                      productoDetermina1VarianteAlt &&
                      productoDetermina2VarianteAlt
                    ) {
                      const variantsProductoDetermina1VarianteAlt =
                        productoDetermina1VarianteAlt.variants;

                      const variantsProductoDetermina2VarianteAlt =
                        productoDetermina2VarianteAlt.variants;

                      const precioDetermina1VarianteAlt =
                        variantsProductoDetermina1VarianteAlt.find(
                          (v) => v.option1 === option1 && v.option2 === option3
                        ).price;

                      const precioDetermina2VarianteAlt =
                        variantsProductoDetermina2VarianteAlt.find(
                          (v) => v.option1 === option2
                        ).price;

                      let precioTotal = 0;

                      for (let i = 0; i < productos.length; i++) {
                        const producto = productos[i];
                        const cantidad = cantidades[i];
                        const precioPrimerVariante =
                          preciosPrimerasVariantes[i];

                        if (producto.id === productoDetermina1VarianteAlt.id) {
                          precioTotal += cantidad * precioDetermina1VarianteAlt;
                        } else if (
                          producto.id === productoDetermina2VarianteAlt.id
                        ) {
                          precioTotal += cantidad * precioDetermina2VarianteAlt;
                        } else {
                          precioTotal += cantidad * precioPrimerVariante;
                        }
                      }

                      const precioTotalString = precioTotal.toFixed(2);

                      if (variant.price != precioTotalString) {
                        console.log(
                          "Actualizando precio de",
                          bundleProduct.title,
                          "para la opción",
                          option1,
                          option2,
                          option3,
                          ":",
                          variant.price,
                          "-->",
                          precioTotal
                        );
                        actualizarPrecio = true;
                        variantsTemp[j].price = precioTotalString;
                      }
                    } else {
                      const productoDetermina1VarianteAlt2 = productos.find(
                        (p) =>
                          p.variants.some(
                            (v) =>
                              v.option1 === option2 && v.option2 === option3
                          )
                      );

                      const productoDetermina2VarianteAlt2 = productos.find(
                        (p) => p.variants.some((v) => v.option1 === option1)
                      );

                      if (
                        productoDetermina1VarianteAlt2 &&
                        productoDetermina2VarianteAlt2
                      ) {
                        const variantsProductoDetermina1VarianteAlt2 =
                          productoDetermina1VarianteAlt2.variants;
                        const variantsProductoDetermina2VarianteAlt2 =
                          productoDetermina2VarianteAlt2.variants;

                        const precioDetermina1VarianteAlt2 =
                          variantsProductoDetermina1VarianteAlt2.find(
                            (v) =>
                              v.option1 === option2 && v.option2 === option3
                          ).price;

                        const precioDetermina2VarianteAlt2 =
                          variantsProductoDetermina2VarianteAlt2.find(
                            (v) => v.option1 === option1
                          ).price;

                        let precioTotal = 0;

                        for (let i = 0; i < productos.length; i++) {
                          const producto = productos[i];
                          const cantidad = cantidades[i];
                          const precioPrimerVariante =
                            preciosPrimerasVariantes[i];

                          if (
                            producto.id === productoDetermina1VarianteAlt2.id
                          ) {
                            precioTotal +=
                              cantidad * precioDetermina1VarianteAlt2;
                          } else if (
                            producto.id === productoDetermina2VarianteAlt2.id
                          ) {
                            precioTotal +=
                              cantidad * precioDetermina2VarianteAlt2;
                          } else {
                            precioTotal += cantidad * precioPrimerVariante;
                          }
                        }

                        const precioTotalString = precioTotal.toFixed(2);

                        if (variant.price != precioTotalString) {
                          console.log(
                            "Actualizando precio de",
                            bundleProduct.title,
                            "para la opción",
                            option1,
                            option2,
                            option3,
                            ":",
                            variant.price,
                            "-->",
                            precioTotal
                          );
                          actualizarPrecio = true;
                          variantsTemp[j].price = precioTotalString;
                        }
                      } else {
                        const p1 = productos.find((p) =>
                          p.variants.some((v) => v.option1 === option1)
                        );
                        const p2 = productos.find((p) =>
                          p.variants.some((v) => v.option1 === option2)
                        );
                        const p3 = productos.find((p) =>
                          p.variants.some((v) => v.option1 === option3)
                        );

                        if (p1 && p2 && p3) {
                          const v1 = p1.variants.find(
                            (v) => v.option1 === option1
                          ).price;

                          const v2 = p2.variants.find(
                            (v) => v.option1 === option2
                          ).price;

                          const v3 = p3.variants.find(
                            (v) => v.option1 === option3
                          ).price;

                          let precioTotal = 0;

                          for (let i = 0; i < productos.length; i++) {
                            const producto = productos[i];
                            const cantidad = cantidades[i];
                            const precioPrimerVariante =
                              preciosPrimerasVariantes[i];

                            if (producto.id === p1.id) {
                              precioTotal += cantidad * v1;
                            } else if (producto.id === p2.id) {
                              precioTotal += cantidad * v2;
                            } else if (producto.id === p3.id) {
                              precioTotal += cantidad * v3;
                            } else {
                              precioTotal += cantidad * precioPrimerVariante;
                            }
                          }

                          const precioTotalString = precioTotal.toFixed(2);

                          if (variant.price != precioTotalString) {
                            console.log(
                              "Actualizando precio de",
                              bundleProduct.title,
                              "para la opción",
                              option1,
                              option2,
                              option3,
                              ":",
                              variant.price,
                              "-->",
                              precioTotal
                            );
                            actualizarPrecio = true;
                            variantsTemp[j].price = precioTotalString;
                          }
                        } else {
                          console.log(
                            "No se encontraron productos que determinen la variante."
                          );

                          break;
                        }
                      }
                    }
                  }
                }
              }

              if (actualizarPrecio) {
                console.log("Actualizando bundle...");
                bundleUpdatePromises.push(() =>
                  updateProductVariants(bundleId, variantsTemp)
                );
              }
              console.log("_".repeat(50));
            }
          }
        }
      }
    }

    console.log(
      "Cantidad de bundles a actualizar:",
      bundleUpdatePromises.length
    );
    await actualizarBundles(bundleUpdatePromises);
  } catch (error) {
    console.log("Error actualizando bundles: ", error);
  }
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

async function actualizarBundles(bundleUpdatePromises) {
  const results = [];

  for (let i = 0; i < bundleUpdatePromises.length; i += 5) {
    console.log("Actualizando bundles en lote...");
    const batch = bundleUpdatePromises.slice(i, i + 5);

    const batchResults = await Promise.all(
      batch.map((promiseFn) => retryWithBackoff(promiseFn))
    );
    results.push(...batchResults);
  }

  console.log("Actualización de bundles completada.");

  return results;
}

module.exports = {
  listProducts,
  getProductById,
  getProductCustomMetafields,
  actualizarVarianteProducto,
  getVariant,
  actualizarBundlesDeProducto,
  productCount,
};
