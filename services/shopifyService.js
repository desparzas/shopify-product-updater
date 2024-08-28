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

async function actualizarVarianteProducto(productoId, variantId, price) {
  return retryWithBackoff(async () => {
    return await shopify.productVariant.update(variantId, { price });
  });
}

async function listProducts() {
  let allProducts = [];
  let params = {
    limit: 250,
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

async function getBundlesWithProduct(productId) {
  try {
    let products = await listProducts();

    console.log("Productos obtenidos:", products.length);

    for (const product of products) {
      const metafields = await getProductCustomMetafields(product.id);
      console.log("Obteniendo metafields para el producto", product.title);
      product.metafields = metafields;
    }

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

    bundles = bundles.filter((bundle) => {
      const metafield = bundle.metafields.find(
        (metafield) => metafield.key === "lista_de_productos"
      );
      let listaProductos = JSON.parse(metafield.value);
      const t = listaProductos.some((producto) => {
        const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
        return id === productId;
      });
      return t;
    });

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

      const b = {
        ...bundle,
        productos: listaProductos,
        cantidades: listaCantidad,
      };

      return b;
    });

    return { bundles };
  } catch (error) {
    console.error("Error obteniendo los bundles con el producto", error);
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
      return [];
    }

    // Obtener todos los productos y sus metafields en paralelo
    const products = await listProducts();
    console.log("Productos obtenidos:", products.length);

    // Mapear productos por ID para búsquedas rápidas
    const productMap = new Map(products.map((p) => [p.id, p]));

    // Obtener metafields de todos los productos
    const metafieldsPromises = products.map((p) => {
      console.log("Obteniendo metafields para el producto:", p.title);
      return getProductCustomMetafields(p.id);
    });
    const allMetafields = await Promise.all(metafieldsPromises);

    // Asignar metafields a cada producto
    products.forEach((product, index) => {
      product.metafields = allMetafields[index];
    });

    // Filtrar bundles basados en los metafields
    const bundles = products
      .filter((product) =>
        product.metafields.some(
          (metafield) =>
            metafield.key === "lista_de_productos" &&
            metafield.namespace === "custom"
        )
      )
      .filter((bundle) => {
        const metafield = bundle.metafields.find(
          (metafield) => metafield.key === "lista_de_productos"
        );
        const listaProductos = JSON.parse(metafield.value);
        return listaProductos.some((producto) => {
          const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
          return id === id;
        });
      });

    // Procesar cada bundle
    const processedBundles = bundles.map((bundle) => {
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
      listaProductos = listaProductos
        .map((producto) => {
          const id = parseInt(producto.replace(/[^0-9]/g, ""), 10);
          return productMap.get(id);
        })
        .filter(Boolean); // Filtrar productos no encontrados

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

    return { bundles: processedBundles };
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
    const { bundles } = await getBundlesWithProduct(id);
    for (const bundle of bundles) {
      const { options, variants, productos, cantidades, title } = bundle;

      console.log("Actualizando bundle:", title);

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

        console.log("ACTUALIZANDO: ", precioActual, "-->", precioTotal);

        if (precioTotal !== precioActual) {
          console.log("Actualizando el precio del bundle");
          await retryWithBackoff(() => {
            return shopify.productVariant.update(variants[0].id, {
              price: precioTotal,
            });
          });
        }
      } else {
        if (options.length === 1) {
          console.log("El bundle tiene una opción");

          // Precalcular precios de variantes por opción1
          const preciosPorOpcion1 = new Map();
          productos.forEach((producto) => {
            producto.variants.forEach((v) => {
              if (!preciosPorOpcion1.has(v.option1)) {
                preciosPorOpcion1.set(v.option1, v.price);
              }
            });
          });

          // Array para almacenar todas las promesas de actualización
          const updatePromises = [];

          for (const variant of variants) {
            const { option1 } = variant;
            const precioTemp = preciosPorOpcion1.get(option1);

            if (!precioTemp) {
              console.log(
                `No se encontró un precio para la opción: ${option1}`
              );
              continue;
            }

            const precioTotal = productos.reduce((total, p, i) => {
              const cantidad = cantidades[i];
              const precio = p.variants[0].price;

              return (
                total +
                cantidad *
                  (p.variants.some((v) => v.option1 === option1)
                    ? precioTemp
                    : precio)
              );
            }, 0);

            if (precioTotal !== variant.price) {
              console.log("ACTUALIZANDO: ", variant.price, "-->", precioTotal);
              const updatePromise = retryWithBackoff(() => {
                return shopify.productVariant.update(variant.id, {
                  price: precioTotal,
                });
              });
              updatePromises.push(updatePromise);
            }
          }

          // Esperar a que todas las actualizaciones se completen
          await Promise.all(updatePromises);
        } else if (options.length === 2) {
          console.log("El bundle tiene dos opciones");
          for (const variant of variants) {
            const { option1, option2 } = variant;
            console.log("Nombre de la variante del paquete:", option1, option2);
            let precioTemp;
            const producto2Options = productos.find((producto) => {
              const { variants } = producto;
              const encontradoVariant = variants.find(
                (v) => v.option1 === option1 && v.option2 === option2
              );
              if (encontradoVariant) {
                precioTemp = encontradoVariant.price;
              }
              return encontradoVariant;
            });
            if (producto2Options && precioTemp) {
              let precioTotal = 0;
              for (let i = 0; i < productos.length; i++) {
                const p = productos[i];
                const cantidad = cantidades[i];
                let precio;
                if (p.id === producto2Options.id) {
                  precio = precioTemp;
                } else {
                  precio = p.variants[0].price;
                }
                precioTotal += cantidad * precio;
              }

              if (precioTotal != variant.price) {
                console.log(
                  "ACTUALIZANDO: ",
                  variant.price,
                  "-->",
                  precioTotal
                );
                await retryWithBackoff(() => {
                  return shopify.productVariant.update(variant.id, {
                    price: precioTotal,
                  });
                });
              }
            } else {
              let precio1;
              const producto1Option1 = productos.find((producto) => {
                const { variants } = producto;
                const encontradoVariant = variants.find(
                  (v) => v.option1 === option1
                );
                if (encontradoVariant) {
                  precio1 = encontradoVariant.price;
                  console.log("Precio del producto 1:", precio1);
                  console.log(
                    "PRODUCTO 1 - VARIANTE ENCONTRADA:",
                    producto.title,
                    encontradoVariant.option1
                  );
                }

                return encontradoVariant;
              });

              let precio2;
              const producto1Option2 = productos.find((producto) => {
                const { variants } = producto;
                const encontradoVariant = variants.find(
                  (v) => v.option1 === option2
                );
                if (encontradoVariant) {
                  precio2 = encontradoVariant.price;
                  console.log("Precio del producto 2:", precio2);
                  console.log(
                    "PRODUCTO 2 - VARIANTE ENCONTRADA:",
                    producto.title,
                    encontradoVariant.option1
                  );
                }

                return encontradoVariant;
              });

              if (producto1Option1 && producto1Option2 && precio1 && precio2) {
                let precioTotal = 0;
                for (let i = 0; i < productos.length; i++) {
                  const p = productos[i];
                  const cantidad = cantidades[i];
                  let precio;
                  if (p.id === producto1Option1.id) {
                    precio = precio1;
                  } else if (p.id === producto1Option2.id) {
                    precio = precio2;
                  } else {
                    precio = p.variants[0].price;
                  }
                  precioTotal += cantidad * precio;
                }

                if (precioTotal != variant.price) {
                  console.log(
                    "ACTUALIZANDO: ",
                    variant.price,
                    "-->",
                    precioTotal
                  );
                  await retryWithBackoff(() => {
                    return shopify.productVariant.update(variant.id, {
                      price: precioTotal,
                    });
                  });
                }
              }
            }
          }
        } else if (options.length === 3) {
          console.log("El bundle tiene tres opciones");
        }
      }

      console.log("_".repeat(50));
    }
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

module.exports = {
  listProducts,
  getProductById,
  getProductCustomMetafields,
  obtenerBundlesContienenProducto,
  actualizarVarianteProducto,
  getVariant,
  actualizarBundlesDeProducto,
};
