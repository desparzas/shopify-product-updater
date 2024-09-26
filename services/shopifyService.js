const config = require("../utils/config");
const consts = require("../utils/products");
const Shopify = require("shopify-api-node");
const productService = require("./productService");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;
const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
});

const productCache = new Map();
const bundlesCache = new Map();

async function retryWithBackoff(fn, retries = 15, delay = 1000) {
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

async function getBundlesDBWithProduct(id) {
  try {
    const productsMongo = await productService.getAllProducts();
    const bundles = productsMongo.filter((product) => {
      const { productos } = product;
      return productos.includes(id);
    });

    return bundles;
  } catch (error) {
    console.error("Error obteniendo los bundles con el producto", error);
    return [];
  }
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

async function getBundleFields(productId) {
  try {
    const metafields = await getProductCustomMetafields(productId);

    const listaProductosMetafield = metafields.find(
      (metafield) =>
        metafield.key === "lista_de_productos" &&
        metafield.namespace === "custom"
    );

    if (!listaProductosMetafield) {
      return {
        productos: [],
        cantidades: [],
      };
    }

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

    let listaCantidad = listaCantidadMetafield
      ? JSON.parse(listaCantidadMetafield.value).map((cantidad) =>
          parseFloat(cantidad)
        )
      : Array(listaProductos.length).fill(1);

    if (listaCantidad.length !== listaProductos.length) {
      listaCantidad = Array(listaProductos.length).fill(1);
    }

    return {
      productos: listaProductos,
      cantidades: listaCantidad,
    };
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      console.log("Producto no encontrado en Shopify");
      return {
        productos: [],
        cantidades: [],
      };
    }
    return {
      productos: [],
      cantidades: [],
    };
  }
}

async function getProductById(productId) {
  try {
    return await retryWithBackoff(() => {
      return shopify.product.get(productId);
    });
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      console.log("Producto no encontrado en Shopify");
      return null;
    }
    return null;
  }
}

async function updateBundle(productId) {
  try {
    const bundle = await getProductById(productId);

    if (!bundle) {
      return {
        validBundle: false,
        error: "El bundle no existe en Shopify",
        optionsOut: [],
        variantsOut: [],
        isNormal: true,
      };
    }

    const bundleFields = await getBundleFields(productId);
    if (!bundleFields) {
      return {
        validBundle: false,
        error: "El producto no tiene campos de bundle, es un producto normal",
        optionsOut: [],
        variantsOut: [],
        isNormal: true,
      };
    }

    const { productos, cantidades } = bundleFields;

    if (productos.length === 0) {
      return {
        validBundle: false,
        error:
          "El producto no tiene productos en el bundle, por lo tano es un producto normal",
        optionsOut: [],
        variantsOut: [],
        isNormal: true,
      };
    }

    const productosPromises = productos.map((id) => {
      return () => getProductById(id);
    });
    const productosBundle = await processPromisesBatch(productosPromises);

    let optionsCount = 0;
    let variantsCount = 0;
    let optionsOut = [];
    let allSimple = true;

    for (const product of productosBundle) {
      if (!isSimpleProduct(product)) {
        allSimple = false;
        break;
      }
    }

    if (allSimple) {
      let precioTotal = 0;
      let minInv = Infinity;
      for (let i = 0; i < productosBundle.length; i++) {
        const producto = productosBundle[i];
        const cantidad = cantidades[i];
        const precio = producto.variants[0].price;
        precioTotal += cantidad * precio;
        // inventario
        const inventario = producto.variants[0].inventory_quantity;
        const inventoryManagement = producto.variants[0].inventory_management;

        if (inventoryManagement === "shopify") {
          // console.log("Inventario", inventario);
          if (inventario / cantidad < minInv) {
            minInv = Math.floor(inventario / cantidad);
            // console.log("Inventario", inventario, cantidad, minInv);
          }
        }
      }

      // console.log("Inventario minimo", minInv);

      const optionDefault = {
        name: "Title",
        values: ["Default Title"],
      };

      optionsOut.push(optionDefault);
      const variantDefault = {
        option1: "Default Title",
        price: precioTotal,
        title: "Default Title",
        inventory_management: "shopify",
        inventory_quantity: minInv,
      };

      // console.log(variantDefault);

      return {
        validBundle: true,
        error: "",
        optionsOut,
        variantsOut: [variantDefault],
        isNormal: false,
      };
    }

    for (let i = 0; i < productosBundle.length; i++) {
      const product = productosBundle[i];
      const cantidad = cantidades[i];
      const { options, variants, title, id } = product;

      const variantesProducto = variants.length ** Math.abs(cantidad);
      const opcionesProducto = options.length * Math.abs(cantidad);

      if (!isSimpleProduct(product)) {
        optionsCount += opcionesProducto;
        if (variantsCount === 0) {
          variantsCount = variantesProducto;
        } else {
          variantsCount *= variantesProducto;
        }

        for (let i = 0; i < cantidad; i++) {
          for (let j = 0; j < options.length; j++) {
            const titleOut = `${title} (${options[j].name})`;

            const optionOut = {
              name: titleOut,
              values: options[j].values,
              productOriginalTitle: title,
              productOriginalId: id,
            };

            optionsOut.push(optionOut);
          }
        }
      }
      if (optionsCount > 3) {
        return {
          validBundle: false,
          error: "El bundle tiene más de 3 opciones",
          optionsOut: [],
          variantsOut: [],
          isNormal: false,
        };
      }
      if (variantsCount > 100) {
        return {
          validBundle: false,
          error: "El bundle tiene más de 100 variantes",
          optionsOut: [],
          variantsOut: [],
          isNormal: false,
        };
      }
    }
    // console.log("Options", optionsOut);

    optionsOut = makeTitlesUnique(optionsOut);
    let variantsOut = [];
    optionsOut = optionsOut.map((option, index) => {
      return {
        ...option,
        position: index + 1,
      };
    });

    // armar las variantes
    if (optionsOut.length === 1) {
      const { values, productOriginalId, productOriginalTitle, name } =
        optionsOut[0];
      const variants = values.map((value) => {
        let priceTotal = 0;
        let minInv = Infinity;
        for (let i = 0; i < productosBundle.length; i++) {
          const product = productosBundle[i];
          const cantidad = cantidades[i];
          let precio = 0;
          if (isSimpleProduct(product)) {
            precio = parseFloat(product.variants[0].price) * cantidad;
            priceTotal += precio;
            const inventario = product.variants[0].inventory_quantity;
            const inventoryManagement =
              product.variants[0].inventory_management;

            if (inventoryManagement === "shopify") {
              if (inventario / cantidad < minInv) {
                minInv = Math.floor(inventario / cantidad);
                // console.log("Inventario", inventario, cantidad, minInv);
              }
            }
          } else {
            const variant = product.variants.find((v) => v.option1 === value);
            precio = parseFloat(variant.price) * cantidad;
            priceTotal += precio;

            const inventario = variant.inventory_quantity;
            const inventoryManagement = variant.inventory_management;

            if (inventoryManagement === "shopify") {
              if (inventario / cantidad < minInv) {
                minInv = Math.floor(inventario / cantidad);
                // console.log("Inventario", inventario, cantidad, minInv);
              }
            }
          }
        }

        if (minInv === Infinity) {
          minInv = 0;
        }
        return {
          option1: value,
          option2: null,
          option3: null,
          price: priceTotal,
          inventory_management: "shopify",
          inventory_quantity: minInv,
        };
      });

      variantsOut = variants;
    } else if (optionsOut.length === 2) {
      const {
        values: values1,
        productOriginalId: idProduct1,
        productOriginalTitle: title1,
        name: name1,
      } = optionsOut[0];
      const {
        values: values2,
        productOriginalId: idProduct2,
        productOriginalTitle: title2,
        name: name2,
      } = optionsOut[1];

      let minInv = Infinity;

      const variants = [];

      let sumaSimples = 0;
      for (let i = 0; i < productosBundle.length; i++) {
        const product = productosBundle[i];
        const cantidad = cantidades[i];

        if (isSimpleProduct(product)) {
          sumaSimples += parseFloat(product.variants[0].price) * cantidad;

          const inventario = product.variants[0].inventory_quantity;
          const inventoryManagement = product.variants[0].inventory_management;

          if (inventoryManagement === "shopify") {
            if (inventario / cantidad < minInv) {
              minInv = Math.floor(inventario / cantidad);
            }
          }
        }
      }

      for (const value1 of values1) {
        for (const value2 of values2) {
          let minVar = Infinity;
          let priceTotal = 0;

          const productoDeterminaVariante = productosBundle.find(
            (p) =>
              p.variants.some(
                (v) => v.option1 === value1 && v.option2 === value2
              ) &&
              p.id === idProduct1 &&
              p.id === idProduct2
          );

          let inventario = 0;
          let inventoryManagement = "";

          if (productoDeterminaVariante) {
            const variant = productoDeterminaVariante.variants.find(
              (v) => v.option1 === value1 && v.option2 === value2
            );
            const t = variant.title;
            let precioDeterminaVariante = variant.price;
            priceTotal += parseFloat(precioDeterminaVariante);

            const inv2 = variant.inventory_quantity;
            const inventoryManagement2 = variant.inventory_management;
            if (inventoryManagement2 === "shopify") {
              if (inv2 < minVar) {
                minVar = inv2;
              }
            }
          } else {
            let producto1, producto2;
            for (const p of productosBundle) {
              if (
                !producto1 &&
                p.variants.some((v) => v.option1 === value1) &&
                p.id === idProduct1
              ) {
                producto1 = p;
              }
              if (
                !producto2 &&
                p.variants.some((v) => v.option1 === value2) &&
                p.id === idProduct2
              ) {
                producto2 = p;
              }
              if (producto1 && producto2) break;
            }

            const variant1 = producto1.variants.find(
              (v) => v.option1 === value1
            );
            const variant2 = producto2.variants.find(
              (v) => v.option1 === value2
            );

            const v1Title = variant1.title;
            const v2Title = variant2.title;

            const precioDeterminaVariante1 = variant1.price;
            const precioDeterminaVariante2 = variant2.price;

            priceTotal +=
              parseFloat(precioDeterminaVariante1) +
              parseFloat(precioDeterminaVariante2);

            const inventario1 = variant1.inventory_quantity;
            const inventoryManagement1 = variant1.inventory_management;

            const inventario2 = variant2.inventory_quantity;
            const inventoryManagement2 = variant2.inventory_management;

            const cantidad1 = cantidades[productosBundle.indexOf(producto1)];
            const cantidad2 = cantidades[productosBundle.indexOf(producto2)];

            if (inventoryManagement1 === "shopify") {
              if (inventario1 < minVar) {
                minVar = Math.floor(inventario1);
              }
            }

            if (inventoryManagement2 === "shopify") {
              if (inventario2 < minVar) {
                minVar = Math.floor(inventario2);
              }
            }
          }
          priceTotal += sumaSimples;
          let m = 0;
          if (minVar < minInv) {
            m = minVar;
          } else {
            m = minInv;
          }

          if (m === Infinity) {
            m = 0;
          }

          variants.push({
            option1: value1,
            option2: value2,
            option3: null,
            price: priceTotal,
            inventory_management: "shopify",
            inventory_quantity: m,
          });
        }
      }
      variantsOut = variants;
    } else if (optionsOut.length === 3) {
      const {
        values: values1,
        productOriginalId: idProduct1,
        productOriginalTitle: title1,
        name: name1,
      } = optionsOut[0];
      const {
        values: values2,
        productOriginalId: idProduct2,
        productOriginalTitle: title2,
        name: name2,
      } = optionsOut[1];
      const {
        values: values3,
        productOriginalId: idProduct3,
        productOriginalTitle: title3,
        name: name3,
      } = optionsOut[2];

      const variants = [];

      let sumaSimples = 0;

      let minInv = Infinity;
      for (let i = 0; i < productosBundle.length; i++) {
        const product = productosBundle[i];
        const cantidad = cantidades[i];

        if (isSimpleProduct(product)) {
          sumaSimples += parseFloat(product.variants[0].price) * cantidad;
          const inventario = product.variants[0].inventory_quantity;
          const inventoryManagement = product.variants[0].inventory_management;
          if (inventoryManagement === "shopify") {
            if (inventario / cantidad < minInv) {
              minInv = Math.floor(inventario / cantidad);
            }
          }
        }
      }

      // console.log("Inventario minimo de los simples", minInv);

      // console.log("IdProduct1", idProduct1);
      // console.log("IdProduct2", idProduct2);
      // console.log("IdProduct3", idProduct3);

      for (const value1 of values1) {
        for (const value2 of values2) {
          for (const value3 of values3) {
            // console.log(
            //   "OPCIONES: '",
            //   value1,
            //   "' - '",
            //   value2,
            //   "' - '",
            //   value3
            // );
            let minVar = Infinity;
            let priceTotal = 0;
            const productoDeterminaVariante = productosBundle.find((p) =>
              p.variants.some(
                (v) =>
                  v.option1 === value1 &&
                  v.option2 === value2 &&
                  v.option3 === value3 &&
                  p.id === idProduct1 &&
                  p.id === idProduct2 &&
                  p.id === idProduct3
              )
            );

            let inventario = 0;
            let inventoryManagement = "";

            if (productoDeterminaVariante) {
              let variante = productoDeterminaVariante.variants.find(
                (v) =>
                  v.option1 === value1 &&
                  v.option2 === value2 &&
                  v.option3 === value3
              );

              let precioDeterminaVariante = variante.price;
              priceTotal += parseFloat(precioDeterminaVariante);

              let vTitle = variante.title;
              const inv3 = variante.inventory_quantity;
              const inventoryManagement3 = variante.inventory_management;

              if (inventoryManagement3 === "shopify") {
                if (inv3 < minVar) {
                  minVar = inv3;
                }
              }
            } else {
              const producto1 = productosBundle.find((p) =>
                p.variants.some(
                  (v) =>
                    (v.option1 === value1 &&
                      v.option2 === value2 &&
                      v.option3 === null &&
                      p.id === idProduct1 &&
                      p.id === idProduct2) ||
                    (v.option1 === value1 &&
                      v.option2 === value3 &&
                      v.option3 === null &&
                      p.id === idProduct1 &&
                      p.id === idProduct3) ||
                    (v.option1 === value2 &&
                      v.option2 === value3 &&
                      v.option3 === null &&
                      p.id === idProduct2 &&
                      p.id === idProduct3)
                )
              );

              const product2 = productosBundle.find((p) =>
                p.variants.some(
                  (v) =>
                    (v.option1 === value1 &&
                      v.option2 === null &&
                      v.option3 === null &&
                      p.id === idProduct1) ||
                    (v.option1 === value2 &&
                      v.option2 === null &&
                      v.option3 === null &&
                      p.id === idProduct2) ||
                    (v.option1 === value3 &&
                      v.option2 === null &&
                      v.option3 === null &&
                      p.id === idProduct3)
                )
              );

              if (producto1 && product2) {
                const var1 = producto1.variants.find(
                  (v) =>
                    (v.option1 === value1 &&
                      v.option2 === value2 &&
                      v.option3 === null) ||
                    (v.option1 === value1 &&
                      v.option2 === value3 &&
                      v.option3 === null) ||
                    (v.option1 === value2 &&
                      v.option2 === value3 &&
                      v.option3 === null)
                );

                const var2 = product2.variants.find(
                  (v) =>
                    (v.option1 === value1 &&
                      v.option2 === null &&
                      v.option3 === null) ||
                    (v.option1 === value2 &&
                      v.option2 === null &&
                      v.option3 === null) ||
                    (v.option1 === value3 &&
                      v.option2 === null &&
                      v.option3 === null)
                );

                // console.log(
                //   "Producto 1",
                //   producto1.title,
                //   " - variante",
                //   var1.title
                // );
                // console.log(
                //   "Producto 2",
                //   product2.title,
                //   " - variante",
                //   var2.title
                // );

                const precioDeterminaVariante1 = var1.price;
                const precioDeterminaVariante2 = var2.price;

                const cantidad1 =
                  cantidades[productosBundle.indexOf(producto1)];
                const cantidad2 = cantidades[productosBundle.indexOf(product2)];

                priceTotal +=
                  parseFloat(precioDeterminaVariante1) * cantidad1 +
                  parseFloat(precioDeterminaVariante2) * cantidad2;

                const inventario1 = var1.inventory_quantity;
                const inventoryManagement1 = var1.inventory_management;

                const inventario2 = var2.inventory_quantity;
                const inventoryManagement2 = var2.inventory_management;

                if (inventoryManagement1 === "shopify") {
                  if (inventario1 < minVar) {
                    minVar = Math.floor(inventario1);
                  }
                }

                if (inventoryManagement2 === "shopify") {
                  if (inventario2 < minVar) {
                    minVar = Math.floor(inventario2);
                  }
                }
              } else {
                let p1, p2, p3;
                let v1, v2, v3;
                let precio1 = 0;
                let precio2 = 0;
                let precio3 = 0;

                for (const p of productosBundle) {
                  if (
                    !p1 &&
                    p.variants.some((v) => v.option1 === value1) &&
                    p.id === idProduct1
                  ) {
                    p1 = p;
                  }
                  if (
                    !p2 &&
                    p.variants.some((v) => v.option1 === value2) &&
                    p.id === idProduct2
                  ) {
                    p2 = p;
                  }
                  if (
                    !p3 &&
                    p.variants.some((v) => v.option1 === value3) &&
                    p.id === idProduct3
                  ) {
                    p3 = p;
                  }
                  if (p1 && p2 && p3) break;
                }

                if (p1) {
                  v1 = p1.variants.find((v) => v.option1 === value1);
                  precio1 = parseFloat(v1.price);
                }

                if (p2) {
                  v2 = p2.variants.find((v) => v.option1 === value2);
                  precio2 = parseFloat(v2.price);
                }

                if (p3) {
                  v3 = p3.variants.find((v) => v.option1 === value3);
                  precio3 = parseFloat(v3.price);
                }

                priceTotal += precio1 + precio2 + precio3;

                if (v1 && v2 && v3) {
                  const inventario1 = v1.inventory_quantity;
                  const inventario2 = v2.inventory_quantity;
                  const inventario3 = v3.inventory_quantity;
                  const inventoryManagement1 = v1.inventory_management;
                  const inventoryManagement2 = v2.inventory_management;
                  const inventoryManagement3 = v3.inventory_management;

                  const cantidad1 = cantidades[productosBundle.indexOf(p1)];
                  const cantidad2 = cantidades[productosBundle.indexOf(p2)];
                  const cantidad3 = cantidades[productosBundle.indexOf(p3)];

                  if (inventoryManagement1 === "shopify") {
                    if (inventario1 < minVar) {
                      minVar = Math.floor(inventario1);
                    }
                  }

                  if (inventoryManagement2 === "shopify") {
                    if (inventario2 < minVar) {
                      minVar = Math.floor(inventario2);
                    }
                  }

                  if (inventoryManagement3 === "shopify") {
                    if (inventario3 < minVar) {
                      minVar = Math.floor(inventario3);
                    }
                  }
                }
              }
            }

            priceTotal += sumaSimples;

            let m = 0;

            if (minVar < minInv) {
              m = minVar;
            } else {
              m = minInv;
            }

            if (m === Infinity) {
              m = 0;
            }
            const v = {
              option1: value1,
              option2: value2,
              option3: value3,
              price: priceTotal,
              inventory_management: "shopify",
              inventory_quantity: m,
            };

            variants.push(v);
          }
        }
      }

      variantsOut = variants;
    }

    optionsOut = optionsOut.map((option, index) => {
      return {
        name: option.name,
        values: option.values,
      };
    });

    return {
      validBundle: true,
      error: "",
      optionsOut,
      variantsOut,
      isNormal: false,
    };
  } catch (error) {
    console.error("Error actualizando el bundle", error);
    return {
      validBundle: false,
      error: "Error validando el bundle",
      optionsOut: [],
      variantsOut: [],
    };
  }
}

async function isValidBundle(productId) {
  try {
    const bundle = await getProductById(productId);

    if (!bundle) {
      return false;
    }

    const bundleFields = await getBundleFields(productId);
    if (!bundleFields) {
      return false;
    }

    const { productos, cantidades } = bundleFields;

    if (productos.length === 0) {
      return false;
    }

    const productosPromises = productos.map((id) => {
      return () => getProductById(id);
    });
    const productosBundle = await processPromisesBatch(productosPromises);

    let optionsCount = 0;
    let variantsCount = 0;

    for (let i = 0; i < productosBundle.length; i++) {
      const product = productosBundle[i];
      const cantidad = cantidades[i];
      const { options, variants, title } = product;

      const variantesProducto = variants.length ** cantidad;
      const opcionesProducto = options.length * cantidad;

      if (!isSimpleProduct(product)) {
        optionsCount += opcionesProducto;
        if (variantsCount === 0) {
          variantsCount = variantesProducto;
        } else {
          variantsCount *= variantesProducto;
        }
      }

      if (optionsCount > 3) {
        return false;
      }

      if (variantsCount > 100) {
        return false;
      }
    }

    return true;
  } catch (error) {
    return false;
  }
}

function makeTitlesUnique(arr) {
  const nameCount = {};

  return arr.map((item) => {
    let { name } = item;

    if (nameCount[name]) {
      // Si ya existe, incrementar el contador y agregarlo al título
      nameCount[name]++;
      name = `${name} ${nameCount[name]}`;
    } else {
      // Si no existe, inicializar el contador
      nameCount[name] = 1;
    }

    return {
      ...item,
      name,
    };
  });
}

async function processPromisesBatch(promises, batchSize = 8) {
  const results = [];
  for (let i = 0; i < promises.length; i += batchSize) {
    const batch = promises.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((promiseFn) => retryWithBackoff(promiseFn))
    );

    results.push(...batchResults);
  }
  return results;
}

async function handleProductUp(pId) {
  try {
    const id = pId;
    const bundleId = id;
    await processProduct(pId);

    const { validBundle, error, optionsOut, variantsOut, isNormal } =
      await updateBundle(id);

    // ACTUALIZAR EL BUNDLE

    if (!isNormal) {
      const updatePromises = [];
      const updateInventoryPromises = [];

      if (validBundle) {
        const bundle = await getProductById(bundleId);
        const { options, variants } = bundle;

        let updateOptions = false;
        let updateVariants = false;

        if (options.length !== optionsOut.length) {
          updateOptions = true;
        }

        if (variants.length !== variantsOut.length) {
          updateVariants = true;
        }

        if (!(updateOptions || updateVariants)) {
          for (let i = 0; i < options.length; i++) {
            const option = options[i];
            const optionOut = optionsOut[i];

            if (
              option.name !== optionOut.name ||
              option.values.length !== optionOut.values.length
            ) {
              updateOptions = true;
              break;
            }

            const { values } = option;
            const { values: valuesOut } = optionOut;

            for (let j = 0; j < values.length; j++) {
              const { value } = values[j];
              const { value: valueOut } = valuesOut[j];

              if (value !== valueOut) {
                updateOptions = true;
                break;
              }
            }
          }

          for (let i = 0; i < variants.length; i++) {
            const variant = variants[i];
            const variantOut = variantsOut[i];
            const { option1, option2, option3, price } = variant;
            const {
              option1: option1Out,
              option2: option2Out,
              option3: option3Out,
              price: priceOut,
            } = variantOut;

            if (
              option1 !== option1Out ||
              option2 !== option2Out ||
              option3 !== option3Out ||
              parseFloat(price) !== parseFloat(priceOut)
            ) {
              updateVariants = true;
              break;
            }
          }
        }

        if (updateOptions || updateVariants) {
          updatePromises.push(async () => {
            console.log(`Updating bundle with ID: ${bundleId}`);
            const p = await shopify.product.update(bundleId, {
              options: optionsOut,
              variants: variantsOut,
            });
          });
        }
      } else {
        console.log(
          "El producto",
          bundleId,
          "no es un producto normal, pero tampoco es un bundle válido"
        );
        updatePromises.push(async () => {
          const p = await shopify.product.update(bundleId, {
            options: [
              {
                name: "Title",
                values: ["Default Title"],
              },
            ],
            variants: [
              {
                option1: "Default Title",
                price: 0,
              },
            ],
          });
        });
      }
      if (updatePromises.length !== 0) {
        await processPromisesBatch(updatePromises);
        console.log("Bundle", bundleId, "actualizado");
      }
      if (validBundle) {
        const bundle = await getProductById(bundleId);
        const variants = bundle.variants;

        if (variantsOut.length && variantsOut.length === variants.length) {
          for (let i = 0; i < variantsOut.length; i++) {
            const variantOut = variantsOut[i];
            const variant = variants[i];
            let inventory_quantity = parseInt(variantOut.inventory_quantity);
            let actual_inventory = parseInt(variant.inventory_quantity);
            if (variant.inventory_management === "shopify") {
              if (inventory_quantity !== actual_inventory) {
                updateInventoryPromises.push(async () => {
                  // console.log(
                  //   "Actualizando inventario del producto",
                  //   variant.id
                  // );
                  await setInventoryLevel(variant.id, inventory_quantity);
                });
              }
            }
          }

          if (updateInventoryPromises.length !== 0) {
            console.log("Actualizando inventarios del bundle", bundleId);
            await processPromisesBatch(updateInventoryPromises);
            console.log("Inventarios del bundle", bundleId, "actualizados");
          }
        }
      }
    } else {
      console.log("El producto", bundleId, "es un producto normal");
    }

    // ACTUALIZAR LOS BUNDLES QUE CONTIENEN EL PRODUCTO
    const updatePromises2 = [];
    const bundles = await getBundlesDBWithProduct(bundleId);

    if (bundles.length !== 0) {
      console.log("El producto", bundleId, "es parte de algún bundle");
      for (const bundle of bundles) {
        const id = bundle.productId;
        updatePromises2.push(() => handleProductUp(id));
      }
      await processPromisesBatch(updatePromises2);
    }
  } catch (error) {
    console.log("Error actualizando el bundle:", error);
  }
}
async function processProduct(id) {
  try {
    const bundleFields = await getBundleFields(id);

    const productDb = await getProductDBById(id);

    const productData = {
      productId: id,
      ...bundleFields,
    };

    let pReturn = null;

    if (!productDb) {
      const productAdded = await productService.saveProduct(productData);
      pReturn = productAdded;
    } else {
      const productUpdated = await productService.updateProduct(
        id,
        productData
      );
      pReturn = productUpdated;
    }
    return {
      id: pReturn.productId,
      productos: pReturn.productos,
      cantidades: pReturn.cantidades,
    };
  } catch (error) {
    console.log("Error procesando el producto:", error);
    return null;
  }
}

async function getProductDBById(id) {
  try {
    const productDb = await retryWithBackoff(() => {
      return productService.getProductById(id);
    });

    return productDb;
  } catch (error) {
    console.error("Error obteniendo el producto", error);
    return null;
  }
}

async function listProducts() {
  let allProducts = [];
  let params = {
    limit: 250,
    // fields: ["id", "title", "product_type", "variants", "options"],
    order: "id asc",
  };

  let hasMoreProducts = true;

  do {
    let products = await retryWithBackoff(() => {
      return shopify.product.list(params);
    });

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
    let q = parseInt(quantityToReduce);
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
          available: inventoryLevels[0].available - q,
        });
      });
    } else {
      // disminuir el inventario del nivel que tenga inventario
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[index].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[index].available - q,
        });
      });
    }
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
  }
}

async function aumentarInventario(variantId, quantityToAdd) {
  try {
    let q = parseInt(quantityToAdd);
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
      // aumentar el inventario del primer nivel
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[0].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[0].available + q,
        });
      });
    } else {
      // aumentar el inventario del nivel que tenga inventario
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[index].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[index].available + q,
        });
      });
    }
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
  }
}

async function setInventoryLevel(variantId, quantity) {
  try {
    let q = parseInt(quantity);
    const variant = await getVariant(variantId);

    if (!variant.inventory_management) {
      console.log("El producto no tiene inventario");
      return;
    }
    const inventoryItemId = variant.inventory_item_id;

    // console.log(inventoryItemId);
    const inventoryLevels = await getInventoryLevels(inventoryItemId);
    // console.log(inventoryLevels);

    const index = inventoryLevels.findIndex(
      (inventoryLevel) => inventoryLevel.available > 0
    );

    if (index === -1) {
      // aumentar el inventario del primer nivel
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[0].location_id,
          inventory_item_id: inventoryItemId,
          available: q,
        });
      });
    } else {
      // aumentar el inventario del nivel que tenga inventario
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[index].location_id,
          inventory_item_id: inventoryItemId,
          available: q,
        });
      });
    }
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
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

async function recursiveProductDiscount(product_id, variant_id, quantity) {
  const productData = await getProductById(product_id);
  if (!productData) {
    console.log("No se encontró el producto con id", product_id);
    return;
  }
  const isBundle = await isValidBundle(product_id);
  const variantRecibida = productData.variants.find((v) => v.id === variant_id);
  const updateProductsPromises = [];
  const processBundlesPromises = [];

  if (isBundle) {
    console.log("-".repeat(50));
    if (isSimpleProduct(productData)) {
      console.log(
        `El producto ${productData.title} es un bundle, además es un producto simple`
      );
      const { productos, cantidades } = await getBundleFields(product_id);
      console.log("Cantidad", quantity);
      console.log("Productos", productos);
      console.log("Cantidades", cantidades);

      const bundles = [];

      for (const p of productos) {
        const isBundle = await isValidBundle(p);
        if (isBundle) {
          bundles.push(p);
        }
      }

      const indexCantidadesBundles = [];
      for (let i = 0; i < productos.length; i++) {
        if (bundles.includes(productos[i])) {
          indexCantidadesBundles.push(i);
        }
      }

      const pFiltered = productos.filter((p) => !bundles.includes(p));

      const indexCantidadesProductos = [];
      for (let i = 0; i < productos.length; i++) {
        if (!bundles.includes(productos[i])) {
          indexCantidadesProductos.push(i);
        }
      }

      console.log(
        `Bundles dentro del producto ${productData.title}: ${bundles} - ${indexCantidadesBundles}`
      );
      console.log(
        `Productos dentro del producto ${productData.title}: ${pFiltered} - ${indexCantidadesProductos}`
      );

      // recorrer los productos que son bundles
      for (let i = 0; i < indexCantidadesBundles.length; i++) {
        const index = indexCantidadesBundles[i];
        const p = productos[index];
        const pData = await getProductById(p);
        let c = cantidades[index];
        c = c * quantity;
        processBundlesPromises.push(() => {
          console.log(
            `Procesando bundle ${pData.title} con id ${p}, su inventario es ${pData.variants[0].inventory_quantity}, reduciendo ${c}`
          );
          return recursiveProductDiscount(p, variant_id, c);
        });
      }

      // recorrer los productos que no son bundles
      for (let i = 0; i < indexCantidadesProductos.length; i++) {
        const index = indexCantidadesProductos[i];
        const p = productos[index];
        const pData = await getProductById(p);
        let c = cantidades[index];
        c = c * quantity;
        const inventory_management = pData.variants[0].inventory_management;
        const inventory_quantity = pData.variants[0].inventory_quantity;

        if (inventory_management === "shopify") {
          updateProductsPromises.push(async () => {
            console.log(
              `Reduciendo inventario de ${pData.title}: ${inventory_quantity} - ${c}`
            );
            return reducirInventario(pData.variants[0].id, c);
          });
        }
      }
    } else {
      console.log(
        `El producto ${productData.title} es un bundle, además es un producto con opciones`
      );
      console.log("Cantidad", quantity);
      const { productos, cantidades } = await getBundleFields(product_id);
      console.log("Productos", productos);
      console.log("Cantidades", cantidades);
      const { title: titleVariant } = variantRecibida;
      console.log("Variante específica", titleVariant);

      const { options } = productData;

      if (options.length === 1) {
        const option1 = options[0];
        const { name: nameOption1, values: valuesOption1 } = option1;
        console.log("Opción 1", nameOption1, " - ", valuesOption1);

        const productosPromises = productos.map((id) => {
          return () => getProductById(id);
        });
        const productosBundle = await processPromisesBatch(productosPromises);

        let productoDeterminaVariante = null;
        let variantDeterminaVariante = null;

        for (const p of productosBundle) {
          const { title } = p;
          if (nameOption1.includes(title)) {
            const variantes = p.variants;
            const variant = variantes.find(
              (v) =>
                v.title === variantRecibida.title &&
                valuesOption1.includes(v.option1)
            );
            if (variant) {
              productoDeterminaVariante = p;
              variantDeterminaVariante = variant;
            }
          }
        }

        if (productoDeterminaVariante) {
          console.log(
            `El producto ${productoDeterminaVariante.title} determina la variante ${titleVariant}`
          );

          let cantidadDeterminante =
            cantidades[productos.indexOf(productoDeterminaVariante.id)];
          const c = cantidadDeterminante * quantity;
          console.log("Cantidad determinante", cantidadDeterminante);
          console.log("Cantidad total", cantidadDeterminante * quantity);
          const { id: idVariante, title: titleVariante } =
            variantDeterminaVariante;
          console.log(
            `Variante determinante: ${titleVariante} - ${idVariante}`
          );

          const isBundleDeterminante = await isValidBundle(
            productoDeterminaVariante.id
          );

          if (isBundleDeterminante) {
            processBundlesPromises.push(() => {
              console.log(
                `Procesando bundle ${productoDeterminaVariante.title} con id ${productoDeterminaVariante.id}, la variante es ${idVariante}, su inventario es ${variantDeterminaVariante.inventory_quantity}, reduciendo ${c}`
              );

              return recursiveProductDiscount(
                productoDeterminaVariante.id,
                variantDeterminaVariante.id,
                c
              );
            });
          } else {
            updateProductsPromises.push(() => {
              console.log(
                `Reduciendo inventario de ${productoDeterminaVariante.title}, variant ${variantDeterminaVariante.title}, con inventario actual ${variantDeterminaVariante.inventory_quantity}, reduciendo ${c}`
              );
              return reducirInventario(idVariante, c);
            });
          }

          const productosFiltrados = productosBundle.filter(
            (p) =>
              p.id !== productoDeterminaVariante.id &&
              p.variants[0].inventory_management === "shopify"
          );

          for (const p of productosFiltrados) {
            const cantidad = cantidades[productos.indexOf(p.id)];
            const c = cantidad * quantity;

            const variant = p.variants[0];
            const { inventory_quantity: inv, id: idVariant } = variant;
            const isBundle = await isValidBundle(p.id);
            if (isBundle) {
              processBundlesPromises.push(() => {
                console.log(
                  `Procesando bundle ${p.title} con id ${p.id}, la variante es ${idVariant}, su inventario es ${inv}, reduciendo ${c}`
                );
                return recursiveProductDiscount(p.id, idVariant, c);
              });
            } else {
              updateProductsPromises.push(() => {
                console.log(
                  `Reduciendo inventario de ${p.title}, con inventario actual ${p.variants[0].inventory_quantity}, reduciendo ${c}`
                );
                return reducirInventario(idVariant, c);
              });
            }
          }
        }
      } else if (options.length === 2) {
        const option1 = options[0];
        const option2 = options[1];

        const varOpt1 = variantRecibida.option1;
        const varOpt2 = variantRecibida.option2;

        console.log("Variante recibida", varOpt1, varOpt2);

        const { name: nameOption1, values: valuesOption1 } = option1;
        const { name: nameOption2, values: valuesOption2 } = option2;

        console.log("Opción 1", nameOption1, " - ", valuesOption1);
        console.log("Opción 2", nameOption2, " - ", valuesOption2);

        // verificar si 1 producto determina la variante o si 2 productos determinan la variante
        const productosPromises = productos.map((id) => {
          return () => getProductById(id);
        });

        const productosBundle = await processPromisesBatch(productosPromises);

        let productoDeterminaVariante = null;
        let variantDeterminaVariante = null;

        for (const p of productosBundle) {
          const { title } = p;
          if (nameOption1.includes(title) && nameOption2.includes(title)) {
            const variantes = p.variants;
            const variant = variantes.find(
              (v) =>
                v.title === variantRecibida.title &&
                v.option1 === varOpt1 &&
                v.option2 === varOpt2
            );
            if (variant) {
              productoDeterminaVariante = p;
              variantDeterminaVariante = variant;
            }
          }
        }

        if (productoDeterminaVariante) {
          const cantidadDeterminante =
            cantidades[productos.indexOf(productoDeterminaVariante.id)];
          const c = cantidadDeterminante * quantity;

          console.log("Cantidad determinante", cantidadDeterminante);
          console.log("Cantidad total", cantidadDeterminante * quantity);

          console.log(
            `El producto ${productoDeterminaVariante.title} determina la variante ${titleVariant}`
          );

          const { id: idVariante, title: titleVariante } =
            variantDeterminaVariante;

          console.log(
            `Variante determinante: ${titleVariante} - ${idVariante}`
          );

          const isBundleDeterminante = await isValidBundle(
            productoDeterminaVariante.id
          );

          if (isBundleDeterminante) {
            processBundlesPromises.push(() => {
              console.log(
                `Procesando bundle ${productoDeterminaVariante.title} con id ${productoDeterminaVariante.id}, la variante es ${idVariante}, su inventario es ${variantDeterminaVariante.inventory_quantity}, reduciendo ${c}`
              );
              return recursiveProductDiscount(
                productoDeterminaVariante.id,
                variantDeterminaVariante.id,
                c
              );
            });
          } else {
            updateProductsPromises.push(() => {
              console.log(
                `Reduciendo inventario de ${productoDeterminaVariante.title}, variant ${variantDeterminaVariante.title}, con inventario actual ${variantDeterminaVariante.inventory_quantity}, reduciendo ${c}`
              );
              return reducirInventario(idVariante, c);
            });
          }

          const productosFiltrados = productosBundle.filter(
            (p) =>
              p.id !== productoDeterminaVariante.id &&
              p.variants[0].inventory_management === "shopify"
          );

          for (const p of productosFiltrados) {
            const cantidad = cantidades[productos.indexOf(p.id)];
            const c = cantidad * quantity;

            const variant = p.variants[0];
            const { inventory_quantity: inv, id: idVariant } = variant;
            const isBundle = await isValidBundle(p.id);
            if (isBundle) {
              processBundlesPromises.push(() => {
                console.log(
                  `Procesando bundle ${p.title} con id ${p.id}, la variante es ${idVariant}, su inventario es ${inv}, reduciendo ${c}`
                );
                return recursiveProductDiscount(p.id, idVariant, c);
              });
            } else {
              updateProductsPromises.push(() => {
                console.log(
                  `Reduciendo inventario de ${p.title}, con inventario actual ${p.variants[0].inventory_quantity}, reduciendo ${c}`
                );
                return reducirInventario(idVariant, c);
              });
            }
          }
        } else {
          let producto1 = null;
          let producto2 = null;

          for (const p of productosBundle) {
            if (nameOption1.includes(p.title)) {
              producto1 = p;
            }
            if (nameOption2.includes(p.title)) {
              producto2 = p;
            }
          }

          if (producto1 && producto2) {
            let v1 = producto1.variants.find(
              (v) => v.option1 === varOpt1 && v.option2 === null
            );

            let v2 = producto2.variants.find(
              (v) => v.option1 === varOpt2 && v.option2 === null
            );

            if (v1 && v2) {
              const cantidad1 = cantidades[productos.indexOf(producto1.id)];
              const cantidad2 = cantidades[productos.indexOf(producto2.id)];

              let c1 = quantity;
              let c2 = quantity;

              const inv1 = v1.inventory_quantity;
              const inv2 = v2.inventory_quantity;

              const idVariant1 = v1.id;
              const idVariant2 = v2.id;

              const isBundle1 = await isValidBundle(producto1.id);
              const isBundle2 = await isValidBundle(producto2.id);

              if (isBundle1) {
                processBundlesPromises.push(() => {
                  console.log(
                    `Procesando bundle ${producto1.title} con id ${producto1.id}, la variante es ${idVariant1}, su inventario es ${inv1}, reduciendo ${c1}`
                  );
                  return recursiveProductDiscount(producto1.id, idVariant1, c1);
                });
              } else {
                updateProductsPromises.push(() => {
                  console.log(
                    `Reduciendo inventario de ${producto1.title}, con inventario actual ${v1.inventory_quantity}, reduciendo ${c1}`
                  );
                  return reducirInventario(idVariant1, c1);
                });
              }

              if (isBundle2) {
                processBundlesPromises.push(() => {
                  console.log(
                    `Procesando bundle ${producto2.title} con id ${producto2.id}, la variante es ${idVariant2}, su inventario es ${inv2}, reduciendo ${c2}`
                  );
                  return recursiveProductDiscount(producto2.id, idVariant2, c2);
                });
              } else {
                updateProductsPromises.push(() => {
                  console.log(
                    `Reduciendo inventario de ${producto2.title}, con inventario actual ${v2.inventory_quantity}, reduciendo ${c2}`
                  );
                  return reducirInventario(idVariant2, c2);
                });
              }

              const productosFiltrados = productosBundle.filter(
                (p) =>
                  p.id !== producto1.id &&
                  p.id !== producto2.id &&
                  p.variants[0].inventory_management === "shopify"
              );

              for (const p of productosFiltrados) {
                const cantidad = cantidades[productos.indexOf(p.id)];
                const c = cantidad * quantity;

                const variant = p.variants[0];
                const { inventory_quantity: inv, id: idVariant } = variant;
                const isBundle = await isValidBundle(p.id);
                if (isBundle) {
                  processBundlesPromises.push(() => {
                    console.log(
                      `Procesando bundle ${p.title} con id ${p.id}, la variante es ${idVariant}, su inventario es ${inv}, reduciendo ${c}`
                    );
                    return recursiveProductDiscount(p.id, idVariant, c);
                  });
                } else {
                  updateProductsPromises.push(() => {
                    console.log(
                      `Reduciendo inventario de ${p.title}, con inventario actual ${p.variants[0].inventory_quantity}, reduciendo ${c}`
                    );
                    return reducirInventario(idVariant, c);
                  });
                }
              }
            }
          }
        }
      } else if (options.length === 3) {
        // 3 opciones
        const option1 = options[0];
        const option2 = options[1];
        const option3 = options[2];

        const varOpt1 = variantRecibida.option1;
        const varOpt2 = variantRecibida.option2;
        const varOpt3 = variantRecibida.option3;

        console.log("Variante recibida", varOpt1, varOpt2, varOpt3);

        const { name: nameOption1, values: valuesOption1 } = option1;
        const { name: nameOption2, values: valuesOption2 } = option2;
        const { name: nameOption3, values: valuesOption3 } = option3;

        console.log("Opción 1", nameOption1, " - ", valuesOption1);
        console.log("Opción 2", nameOption2, " - ", valuesOption2);
        console.log("Opción 3", nameOption3, " - ", valuesOption3);

        // verificar si 1 producto determina la variante o si 2 productos determinan la variante o si 3 productos determinan la variante
        const productosPromises = productos.map((id) => {
          return () => getProductById(id);
        });

        const productosBundle = await processPromisesBatch(productosPromises);

        let productoDeterminaVariante = null;
        let varianteDeterminaVariante = null;

        for (const p of productosBundle) {
          const { title } = p;
          if (
            nameOption1.includes(title) &&
            nameOption2.includes(title) &&
            nameOption3.includes(title)
          ) {
            const variantes = p.variants;
            const variant = variantes.find(
              (v) =>
                v.title === variantRecibida.title &&
                v.option1 === varOpt1 &&
                v.option2 === varOpt2 &&
                v.option3 === varOpt3
            );
            if (variant) {
              productoDeterminaVariante = p;
              varianteDeterminaVariante = variant;
            }
          }
        }

        if (productoDeterminaVariante && varianteDeterminaVariante) {
          const cantidadDeterminante =
            cantidades[productos.indexOf(productoDeterminaVariante.id)];
          const c = quantity;

          console.log("Cantidad determinante", cantidadDeterminante);
          console.log("Cantidad total", cantidadDeterminante * quantity);

          console.log(
            `El producto ${productoDeterminaVariante.title} determina la variante ${titleVariant}`
          );

          const { id: idVariante, title: titleVariante } =
            varianteDeterminaVariante;

          console.log(
            `Variante determinante: ${titleVariante} - ${idVariante}`
          );

          const isBundleDeterminante = await isValidBundle(
            productoDeterminaVariante.id
          );

          if (isBundleDeterminante) {
            processBundlesPromises.push(() => {
              console.log(
                `Procesando bundle ${productoDeterminaVariante.title} con id ${productoDeterminaVariante.id}, la variante es ${idVariante}, su inventario es ${varianteDeterminaVariante.inventory_quantity}, reduciendo ${c}`
              );
              return recursiveProductDiscount(
                productoDeterminaVariante.id,
                varianteDeterminaVariante.id,
                c
              );
            });
          } else {
            updateProductsPromises.push(() => {
              console.log(
                `Reduciendo inventario de ${productoDeterminaVariante.title}, variant ${varianteDeterminaVariante.title}, con inventario actual ${varianteDeterminaVariante.inventory_quantity}, reduciendo ${c}`
              );
              return reducirInventario(idVariante, c);
            });
          }

          const productosFiltrados = productosBundle.filter(
            (p) =>
              p.id !== productoDeterminaVariante.id &&
              p.variants[0].inventory_management === "shopify"
          );

          for (const p of productosFiltrados) {
            const cantidad = cantidades[productos.indexOf(p.id)];
            const c = cantidad * quantity;

            const variant = p.variants[0];
            const { inventory_quantity: inv, id: idVariant } = variant;
            const isBundle = await isValidBundle(p.id);
            if (isBundle) {
              processBundlesPromises.push(() => {
                console.log(
                  `Procesando bundle ${p.title} con id ${p.id}, la variante es ${idVariant}, su inventario es ${inv}, reduciendo ${c}`
                );
                return recursiveProductDiscount(p.id, idVariant, c);
              });
            } else {
              updateProductsPromises.push(() => {
                console.log(
                  `Reduciendo inventario de ${p.title}, con inventario actual ${p.variants[0].inventory_quantity}, reduciendo ${c}`
                );
                return reducirInventario(idVariant, c);
              });
            }
          }
        } else {
          let producto1 = null;
          let producto2 = null;
          let variant1 = null;
          let variant2 = null;

          for (const p of productosBundle) {
            if (
              (nameOption1.includes(p.title) &&
                nameOption2.includes(p.title) &&
                !nameOption3.includes(p.title)) ||
              (nameOption1.includes(p.title) &&
                !nameOption2.includes(p.title) &&
                nameOption3.includes(p.title)) ||
              (!nameOption1.includes(p.title) &&
                nameOption2.includes(p.title) &&
                nameOption3.includes(p.title))
            ) {
              producto1 = p;
              variant1 = p.variants.find(
                (v) =>
                  (v.option1 === varOpt1 &&
                    v.option2 === varOpt2 &&
                    v.option3 === null) ||
                  (v.option1 === varOpt1 &&
                    v.option2 === varOpt3 &&
                    v.option3 === null) ||
                  (v.option1 === varOpt2 &&
                    v.option2 === varOpt3 &&
                    v.option3 === null)
              );
            }
            if (
              (nameOption1.includes(p.title) &&
                !nameOption2.includes(p.title) &&
                !nameOption3.includes(p.title)) ||
              (!nameOption1.includes(p.title) &&
                nameOption2.includes(p.title) &&
                !nameOption3.includes(p.title)) ||
              (!nameOption1.includes(p.title) &&
                !nameOption2.includes(p.title) &&
                nameOption3.includes(p.title))
            ) {
              producto2 = p;
              variant2 = p.variants.find(
                (v) =>
                  (v.option1 === varOpt1 && v.option2 === null) ||
                  (v.option1 === varOpt2 && v.option2 === null) ||
                  (v.option1 === varOpt3 && v.option2 === null)
              );
            }
          }

          if (producto1 && producto2 && variant1 && variant2) {
            console.log(
              `El producto ${producto1.title} y ${producto2.title} determinan la variante ${titleVariant}`
            );

            console.log("Variante 1", variant1.title);
            console.log("Variante 2", variant2.title);

            const cantidad1 = cantidades[productos.indexOf(producto1.id)];
            const cantidad2 = cantidades[productos.indexOf(producto2.id)];

            const c1 = quantity;
            const c2 = quantity;

            const inv1 = variant1.inventory_quantity;
            const inv2 = variant2.inventory_quantity;

            const idVariant1 = variant1.id;
            const idVariant2 = variant2.id;

            const isBundle1 = await isValidBundle(producto1.id);
            const isBundle2 = await isValidBundle(producto2.id);

            if (isBundle1) {
              processBundlesPromises.push(() => {
                console.log(
                  `Procesando bundle ${producto1.title} con id ${producto1.id}, la variante es ${idVariant1}, su inventario es ${inv1}, reduciendo ${c1}`
                );
                return recursiveProductDiscount(producto1.id, idVariant1, c1);
              });
            } else {
              updateProductsPromises.push(() => {
                console.log(
                  `Reduciendo inventario de ${producto1.title}, con inventario actual ${variant1.inventory_quantity}, reduciendo ${c1}`
                );
                return reducirInventario(idVariant1, c1);
              });
            }

            if (isBundle2) {
              processBundlesPromises.push(() => {
                console.log(
                  `Procesando bundle ${producto2.title} con id ${producto2.id}, la variante es ${idVariant2}, su inventario es ${inv2}, reduciendo ${c2}`
                );
                return recursiveProductDiscount(producto2.id, idVariant2, c2);
              });
            } else {
              updateProductsPromises.push(() => {
                console.log(
                  `Reduciendo inventario de ${producto2.title}, con inventario actual ${variant2.inventory_quantity}, reduciendo ${c2}`
                );
                return reducirInventario(idVariant2, c2);
              });
            }

            const productosFiltrados = productosBundle.filter(
              (p) =>
                p.id !== producto1.id &&
                p.id !== producto2.id &&
                p.variants[0].inventory_management === "shopify"
            );

            for (const p of productosFiltrados) {
              const cantidad = cantidades[productos.indexOf(p.id)];
              const c = cantidad * quantity;

              const variant = p.variants[0];
              const { inventory_quantity: inv, id: idVariant } = variant;
              const isBundle = await isValidBundle(p.id);
              if (isBundle) {
                processBundlesPromises.push(() => {
                  console.log(
                    `Procesando bundle ${p.title} con id ${p.id}, la variante es ${idVariant}, su inventario es ${inv}, reduciendo ${c}`
                  );
                  return recursiveProductDiscount(p.id, idVariant, c);
                });
              } else {
                updateProductsPromises.push(() => {
                  console.log(
                    `Reduciendo inventario de ${p.title}, con inventario actual ${p.variants[0].inventory_quantity}, reduciendo ${c}`
                  );
                  return reducirInventario(idVariant, c);
                });
              }
            }
          } else {
            // 3 productos determinan la variante
            let producto1 = null;
            let producto2 = null;
            let producto3 = null;
            let variant1 = null;
            let variant2 = null;
            let variant3 = null;

            for (const p of productosBundle) {
              if (nameOption1.includes(p.title)) {
                producto1 = p;
                variant1 = p.variants.find(
                  (v) =>
                    v.option1 === varOpt1 &&
                    v.option2 === null &&
                    v.option3 === null
                );
              }
              if (nameOption2.includes(p.title)) {
                producto2 = p;
                variant2 = p.variants.find(
                  (v) =>
                    v.option1 === varOpt2 &&
                    v.option2 === null &&
                    v.option3 === null
                );
              }
              if (nameOption3.includes(p.title)) {
                producto3 = p;
                variant3 = p.variants.find(
                  (v) =>
                    v.option1 === varOpt3 &&
                    v.option2 === null &&
                    v.option3 === null
                );
              }
            }

            if (
              producto1 &&
              producto2 &&
              producto3 &&
              variant1 &&
              variant2 &&
              variant3
            ) {
              const cantidad1 = cantidades[productos.indexOf(producto1.id)];
              const cantidad2 = cantidades[productos.indexOf(producto2.id)];
              const cantidad3 = cantidades[productos.indexOf(producto3.id)];

              const c1 = quantity;
              const c2 = quantity;
              const c3 = quantity;

              const inv1 = variant1.inventory_quantity;
              const inv2 = variant2.inventory_quantity;
              const inv3 = variant3.inventory_quantity;

              const idVariant1 = variant1.id;
              const idVariant2 = variant2.id;
              const idVariant3 = variant3.id;

              const isBundle1 = await isValidBundle(producto1.id);
              const isBundle2 = await isValidBundle(producto2.id);
              const isBundle3 = await isValidBundle(producto3.id);

              if (isBundle1) {
                processBundlesPromises.push(() => {
                  console.log(
                    `Procesando bundle ${producto1.title} con id ${producto1.id}, la variante es ${idVariant1}, su inventario es ${inv1}, reduciendo ${c1}`
                  );
                  return recursiveProductDiscount(producto1.id, idVariant1, c1);
                });
              } else {
                updateProductsPromises.push(() => {
                  console.log(
                    `Reduciendo inventario de ${producto1.title}, con inventario actual ${variant1.inventory_quantity}, reduciendo ${c1}`
                  );
                  return reducirInventario(idVariant1, c1);
                });
              }

              if (isBundle2) {
                processBundlesPromises.push(() => {
                  console.log(
                    `Procesando bundle ${producto2.title} con id ${producto2.id}, la variante es ${idVariant2}, su inventario es ${inv2}, reduciendo ${c2}`
                  );
                  return recursiveProductDiscount(producto2.id, idVariant2, c2);
                });
              } else {
                updateProductsPromises.push(() => {
                  console.log(
                    `Reduciendo inventario de ${producto2.title}, con inventario actual ${variant2.inventory_quantity}, reduciendo ${c2}`
                  );
                  return reducirInventario(idVariant2, c2);
                });
              }

              if (isBundle3) {
                processBundlesPromises.push(() => {
                  console.log(
                    `Procesando bundle ${producto3.title} con id ${producto3.id}, la variante es ${idVariant3}, su inventario es ${inv3}, reduciendo ${c3}`
                  );
                  return recursiveProductDiscount(producto3.id, idVariant3, c3);
                });
              } else {
                updateProductsPromises.push(() => {
                  console.log(
                    `Reduciendo inventario de ${producto3.title}, con inventario actual ${variant3.inventory_quantity}, reduciendo ${c3}`
                  );
                  return reducirInventario(idVariant3, c3);
                });
              }

              const productosFiltrados = productosBundle.filter(
                (p) =>
                  p.id !== producto1.id &&
                  p.id !== producto2.id &&
                  p.id !== producto3.id &&
                  p.variants[0].inventory_management === "shopify"
              );

              for (const p of productosFiltrados) {
                const cantidad = cantidades[productos.indexOf(p.id)];
                const c = cantidad * quantity;

                const variant = p.variants[0];
                const { inventory_quantity: inv, id: idVariant } = variant;
                const isBundle = await isValidBundle(p.id);
                if (isBundle) {
                  processBundlesPromises.push(() => {
                    console.log(
                      `Procesando bundle ${p.title} con id ${p.id}, la variante es ${idVariant}, su inventario es ${inv}, reduciendo ${c}`
                    );
                    return recursiveProductDiscount(p.id, idVariant, c);
                  });
                } else {
                  updateProductsPromises.push(() => {
                    console.log(
                      `Reduciendo inventario de ${p.title}, con inventario actual ${p.variants[0].inventory_quantity}, reduciendo ${c}`
                    );
                    return reducirInventario(idVariant, c);
                  });
                }
              }
            }
          }
        }
      }
    }
    console.log("-".repeat(50));
  } else {
    console.log(
      `El producto ${productData.title} no es un bundle, por lo tanto no se procesará`
    );
  }

  if (updateProductsPromises.length !== 0) {
    console.log(
      "Procesando promesas de productos del producto",
      productData.title
    );

    await processPromisesBatch(updateProductsPromises);
  }

  if (processBundlesPromises.length !== 0) {
    console.log(
      "Procesando promesas de bundles del producto",
      productData.title
    );
    await processPromisesBatch(processBundlesPromises);
  }
}

async function handleOrderCreate(orderData) {
  try {
    const { line_items } = orderData;

    for (const lineItem of line_items) {
      const { product_id, variant_id, quantity, title } = lineItem;
      await recursiveProductDiscount(product_id, variant_id, quantity);
    }
  } catch (error) {
    console.error("Error procesando la orden:", error);
  }
}

module.exports = {
  getProductDBById,
  getProductCustomMetafields,
  actualizarVarianteProducto,
  productCount,
  getBundleFields,
  updateBundle,
  isValidBundle,
  handleProductUp,
  getBundlesDBWithProduct,
  listProducts,
  reducirInventario,
  aumentarInventario,
  handleOrderCreate,
  recursiveProductDiscount,
  processProduct,
  getProductById,
};
