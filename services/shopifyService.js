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
      };
    }

    const bundleFields = await getBundleFields(productId);
    if (!bundleFields) {
      return {
        validBundle: false,
        error: "El producto no tiene campos de bundle",
        optionsOut: [],
        variantsOut: [],
      };
    }

    const { productos, cantidades } = bundleFields;

    if (productos.length === 0) {
      return {
        validBundle: false,
        error: "El bundle no tiene productos",
        optionsOut: [],
        variantsOut: [],
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
          console.log("Inventario", inventario);
          if (inventario / cantidad < minInv) {
            minInv = Math.floor(inventario / cantidad);
            console.log("Inventario", inventario, cantidad, minInv);
          }
        }
      }

      console.log("Inventario minimo", minInv);

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

      console.log(variantDefault);

      return {
        validBundle: true,
        error: "",
        optionsOut,

        variantsOut: [variantDefault],
      };
    }

    for (let i = 0; i < productosBundle.length; i++) {
      const product = productosBundle[i];
      const cantidad = cantidades[i];
      const { options, variants, title, id } = product;

      const variantesProducto = variants.length ** cantidad;
      const opcionesProducto = options.length * cantidad;

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
        };
      }

      if (variantsCount > 100) {
        return {
          validBundle: false,
          error: "El bundle tiene más de 100 variantes",
          optionsOut: [],
          variantsOut: [],
        };
      }
    }
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
                console.log("Inventario", inventario, cantidad, minInv);
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
                console.log("Inventario", inventario, cantidad, minInv);
              }
            }
          }
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
              console.log("Inventario", inventario, cantidad, minInv);
            }
          }
        }
      }

      console.log("Inventario minimo de los simples", minInv);

      for (const value1 of values1) {
        for (const value2 of values2) {
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

            inventario = variant.inventory_quantity;
            inventoryManagement = variant.inventory_management;

            console.log("Variante - Inventario:", t, inventario);
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

            const precioDeterminaVariante1 = variant1.price;
            const precioDeterminaVariante2 = variant2.price;

            priceTotal +=
              parseFloat(precioDeterminaVariante1) +
              parseFloat(precioDeterminaVariante2);

            const inventario1 = variant1.inventory_quantity;
            const inventoryManagement1 = variant1.inventory_management;

            const inventario2 = variant2.inventory_quantity;
            const inventoryManagement2 = variant2.inventory_management;

            if (inventoryManagement1 === "shopify") {
              if (
                inventario1 / cantidades[productosBundle.indexOf(producto1)] <
                inventario
              ) {
                inventario = Math.floor(
                  inventario1 / cantidades[productosBundle.indexOf(producto1)]
                );
              }
            }

            if (inventoryManagement2 === "shopify") {
              if (
                inventario2 / cantidades[productosBundle.indexOf(producto2)] <
                inventario
              ) {
                inventario = Math.floor(
                  inventario2 / cantidades[productosBundle.indexOf(producto2)]
                );
              }
            }
          }
          priceTotal += sumaSimples;

          if (inventoryManagement === "shopify") {
            if (inventario > minInv) {
              inventario = minInv;
            }
          }

          console.log("Inventario a asignar", inventario);

          variants.push({
            option1: value1,
            option2: value2,
            option3: null,
            price: priceTotal,
            inventory_management: "shopify",
            inventory_quantity: inventario,
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
        }

        const inventario = product.variants[0].inventory_quantity;
        const inventoryManagement = product.variants[0].inventory_management;

        if (inventoryManagement === "shopify") {
          if (inventario / cantidad < minInv) {
            minInv = Math.floor(inventario / cantidad);
            console.log("Inventario", inventario, cantidad, minInv);
          }
        }
      }

      for (const value1 of values1) {
        for (const value2 of values2) {
          for (const value3 of values3) {
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
                  v.option3 === value3 &&
                  p.id === idProduct1 &&
                  p.id === idProduct2 &&
                  p.id === idProduct3
              );

              let precioDeterminaVariante = variante.price;

              priceTotal += parseFloat(precioDeterminaVariante);

              inventario = variante.inventory_quantity;
              inventoryManagement = variante.inventory_management;

              console.log("Variante - Inventario:", variante.title, inventario);
            } else {
              const producto1 = productosBundle.find((p) =>
                p.variants.some(
                  (v) =>
                    (v.option1 === value1 &&
                      v.option2 === value2 &&
                      p.id === idProduct1 &&
                      p.id === idProduct2) ||
                    (v.option1 === value1 &&
                      v.option3 === value3 &&
                      p.id === idProduct1 &&
                      p.id === idProduct3) ||
                    (v.option2 === value2 &&
                      v.option3 === value3 &&
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
                    (v.option1 === value1 && v.option2 === value2) ||
                    (v.option1 === value1 && v.option3 === value3) ||
                    (v.option2 === value2 && v.option3 === value3)
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
                  if (inventario1 / cantidad1 < inventario) {
                    inventario = Math.floor(inventario1 / cantidad1);
                  }
                }

                if (inventoryManagement2 === "shopify") {
                  if (inventario2 / cantidad2 < inventario) {
                    inventario = Math.floor(inventario2 / cantidad2);
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

                if (v1) {
                  const inventario1 = v1.inventory_quantity;
                  const inventoryManagement1 = v1.inventory_management;

                  if (inventoryManagement1 === "shopify") {
                    if (
                      inventario1 / cantidades[productosBundle.indexOf(p1)] <
                      minInv
                    ) {
                      minInv = Math.floor(
                        inventario1 / cantidades[productosBundle.indexOf(p1)]
                      );
                      console.log(
                        "Inventario",
                        inventario1,
                        cantidades[productosBundle.indexOf(p1)],
                        minInv
                      );
                    }
                  }
                }

                if (v2) {
                  const inventario2 = v2.inventory_quantity;
                  const inventoryManagement2 = v2.inventory_management;

                  if (inventoryManagement2 === "shopify") {
                    if (
                      inventario2 / cantidades[productosBundle.indexOf(p2)] <
                      minInv
                    ) {
                      minInv = Math.floor(
                        inventario2 / cantidades[productosBundle.indexOf(p2)]
                      );
                      console.log(
                        "Inventario",
                        inventario2,
                        cantidades[productosBundle.indexOf(p2)],
                        minInv
                      );
                    }
                  }
                }

                if (v3) {
                  const inventario3 = v3.inventory_quantity;
                  const inventoryManagement3 = v3.inventory_management;

                  if (inventoryManagement3 === "shopify") {
                    if (
                      inventario3 / cantidades[productosBundle.indexOf(p3)] <
                      minInv
                    ) {
                      minInv = Math.floor(
                        inventario3 / cantidades[productosBundle.indexOf(p3)]
                      );
                      console.log(
                        "Inventario",
                        inventario3,
                        cantidades[productosBundle.indexOf(p3)],
                        minInv
                      );
                    }
                  }
                }
              }
            }

            priceTotal += sumaSimples;

            if (inventoryManagement === "shopify") {
              if (inventario > minInv) {
                inventario = minInv;
              }
            }

            variants.push({
              option1: value1,
              option2: value2,
              option3: value3,
              price: priceTotal,
              inventory_management: "shopify",
              inventory_quantity: inventario,
            });
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
    };
  } catch (error) {
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

async function processPromisesBatch(promises, batchSize = 10) {
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
    const p = await processProduct(pId);
    // console.log("Producto procesado:", p);

    const { validBundle, error, optionsOut, variantsOut } = await updateBundle(
      id
    );

    const updatePromises = [];

    const updateInventoryPromises = [];

    if (validBundle) {
      const bundle = await getProductById(bundleId);
      // console.log("Bundle", bundle);
      const { options, variants } = bundle;
      let updateOptions = false;
      let updateVariants = false;

      if (options.length !== optionsOut.length) {
        updateOptions = true;
      }

      if (variants.length !== variantsOut.length) {
        updateVariants = true;
      }

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

      if (updateOptions || updateVariants) {
        updatePromises.push(async () => {
          console.log(`Updating bundle with ID: ${bundleId}`);
          const p = await shopify.product.update(bundleId, {
            options: optionsOut,
            variants: variantsOut,
          });
        });
      }
    }
    if (updatePromises.length !== 0) {
      await processPromisesBatch(updatePromises);
      console.log("Bundle", bundleId, "actualizado");
    }

    // actualizar los inventarios

    // obtener las variantes del bundle
    const bundle = await getProductById(bundleId);

    const variants = bundle.variants;

    if (variantsOut.length && variantsOut.length === variants.length) {
      for (let i = 0; i < variantsOut.length; i++) {
        const variantOut = variantsOut[i];
        const inventory_quantity = variantOut.inventory_quantity;
        const variant = variants[i];
        // console.log("Variantes", variant, variantOut);

        if (variant.inventory_management === "shopify") {
          updateInventoryPromises.push(async () => {
            console.log("Actualizando inventario de la variante", variant.id);
            console.log("Inventario", inventory_quantity);
            await setInventoryLevel(variant.id, inventory_quantity);
          });
        }
      }

      if (updateInventoryPromises.length !== 0) {
        await processPromisesBatch(updateInventoryPromises);
        console.log("Inventarios del bundle", bundleId, "actualizados");
      }
    }

    // console.log("Bundle actualizado:", p);

    // actualizar los bundles que contienen el producto
    const updatePromises2 = [];

    const bundles = await getBundlesDBWithProduct(bundleId);

    if (bundles.length !== 0) {
      for (const bundle of bundles) {
        const id = bundle.productId;
        updatePromises2.push(() => handleProductUp(id));
      }
      await processPromisesBatch(updatePromises2);
    } else {
      console.log("El producto", bundleId, "no es parte de ningún bundle");
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
    fields: ["id", "title", "product_type", "variants", "options"],
    order: "id asc",
  };

  let hasMoreProducts = true;

  do {
    let products = await retryWithBackoff(() => {
      return shopify.product.list(params);
    });

    products = products.sort((a, b) => a.id - b.id);

    console.log(products.length);
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

async function aumentarInventario(variantId, quantityToAdd) {
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
      // aumentar el inventario del primer nivel
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[0].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[0].available + quantityToAdd,
        });
      });
    } else {
      // aumentar el inventario del nivel que tenga inventario
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[index].location_id,
          inventory_item_id: inventoryItemId,
          available: inventoryLevels[index].available + quantityToAdd,
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
          available: quantity,
        });
      });
    } else {
      // aumentar el inventario del nivel que tenga inventario
      await retryWithBackoff(() => {
        return shopify.inventoryLevel.set({
          location_id: inventoryLevels[index].location_id,
          inventory_item_id: inventoryItemId,
          available: quantity,
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
};
