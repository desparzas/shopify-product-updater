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

    console.log("Lista de productos:", listaProductos.length);
    console.log("Lista de cantidades:", listaCantidad.length);

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
      console.log("El bundle no existe en Shopify");
      return {
        validBundle: false,
        error: "El bundle no existe en Shopify",
        optionsOut: [],
      };
    }

    const bundleFields = await getBundleFields(productId);
    if (!bundleFields) {
      console.log("El producto no tiene campos de bundle");
      return {
        validBundle: false,
        error: "El producto no tiene campos de bundle",
        optionsOut: [],
      };
    }

    const { productos, cantidades } = bundleFields;
    console.log("Productos:", productos);
    console.log("Cantidades:", cantidades);

    if (productos.length === 0) {
      console.log("El bundle no tiene productos");
      return {
        validBundle: false,
        error: "El bundle no tiene productos",
        optionsOut: [],
      };
    }

    const productosPromises = productos.map((id) => {
      return () => getProductById(id);
    });
    const productosBundle = await processPromisesBatch(productosPromises);

    let optionsCount = 0;
    let variantsCount = 0;

    let optionsOut = [];

    // primero validar si todos sus productos son simples

    let allSimple = true;

    for (const product of productosBundle) {
      if (!isSimpleProduct(product)) {
        allSimple = false;
        break;
      }
    }

    if (allSimple) {
      // calcular el precio total
      let precioTotal = 0;
      for (let i = 0; i < productosBundle.length; i++) {
        const producto = productosBundle[i];
        const cantidad = cantidades[i];
        const precio = producto.variants[0].price;
        precioTotal += cantidad * precio;
      }

      const optionDefault = {
        name: "Title",
        values: ["Default Title"],
      };

      optionsOut.push(optionDefault);
      const variantDefault = {
        option1: "Default Title",
        price: precioTotal,
        title: "Default Title",
      };

      return {
        validBundle: true,
        error: "",
        optionsOut,

        variantsOut: [variantDefault],
      };
    }

    console.log("Calculando opciones...");
    for (let i = 0; i < productosBundle.length; i++) {
      const product = productosBundle[i];
      const cantidad = cantidades[i];
      const { options, variants, title, id } = product;

      const variantesProducto = variants.length ** cantidad;
      const opcionesProducto = options.length * cantidad;

      if (!isSimpleProduct(product)) {
        console.log("-".repeat(50));
        console.log("-".repeat(50));
        console.log(" ");

        console.log("Producto con variantes:", title);
        console.log("Cantidad:", cantidad);

        optionsCount += opcionesProducto;
        if (variantsCount === 0) {
          variantsCount = variantesProducto;
        } else {
          variantsCount *= variantesProducto;
        }

        console.log("Opciones del producto:", options.length);

        console.log("Obteniendo opciones del producto...");

        for (let i = 0; i < cantidad; i++) {
          for (let j = 0; j < options.length; j++) {
            console.log("-".repeat(25));

            const titleOut = `${title} (${options[j].name})`;
            console.log("Opción", j + 1, ":", options[j].name);
            console.log("Título de la variante:", titleOut);

            const optionOut = {
              name: titleOut,
              values: options[j].values,
              productOriginalTitle: title,
              productOriginalId: id,
            };

            optionsOut.push(optionOut);

            console.log("-".repeat(25));
          }
        }
        console.log(" ");
        console.log("-".repeat(50));
        console.log("-".repeat(50));
        console.log(" ");
        console.log(" ");
      }
      if (optionsCount > 3) {
        console.log("El bundle tiene más de 3 opciones");
        return {
          validBundle: false,
          error: "El bundle tiene más de 3 opciones",
          optionsOut: [],
        };
      }

      if (variantsCount > 100) {
        console.log("El bundle tiene más de 100 variantes");
        return {
          validBundle: false,
          error: "El bundle tiene más de 100 variantes",
          optionsOut: [],
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
    console.log("Calculando variantes.......");
    // armar las variantes
    if (optionsOut.length === 1) {
      const { values, productOriginalId, productOriginalTitle, name } =
        optionsOut[0];

      // calcular el precio
      const variants = values.map((value) => {
        console.log("-".repeat(50));
        console.log("Calculando variante para:", value);
        console.log("-".repeat(50));

        let priceTotal = 0;

        for (let i = 0; i < productosBundle.length; i++) {
          console.log(" ");
          console.log("-".repeat(50));
          const product = productosBundle[i];
          const cantidad = cantidades[i];
          console.log("Producto:", product.title);
          let precio = 0;
          if (isSimpleProduct(product)) {
            console.log(
              "Precio Unitario - Cantidad :",
              product.variants[0].price,
              "-",
              cantidad
            );
            precio = parseFloat(product.variants[0].price) * cantidad;

            console.log("Precio calculado:", precio);
            priceTotal += precio;
          } else {
            const variant = product.variants.find((v) => v.option1 === value);
            console.log("Variante - PRECIO", variant.title, variant.price);
            precio = parseFloat(variant.price) * cantidad;
            priceTotal += precio;
          }

          console.log("Subtotal:", precio);
          console.log(" ");
          console.log("Total acumulado:", priceTotal);
          console.log("-".repeat(50));
        }

        console.log("Precio de la variante:", priceTotal);
        console.log("-".repeat(50));
        console.log(" ");

        return {
          option1: value,
          option2: null,
          option3: null,
          price: priceTotal,
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

      console.log("Opciones 1:", values1);
      console.log("Opciones 2:", values2);

      console.log("Productos:", idProduct1, idProduct2);
      console.log("Títulos:", title1, title2);

      console.log("Nombre 1:", name1);
      console.log("Nombre 2:", name2);

      const variants = [];

      let sumaSimples = 0;
      for (let i = 0; i < productosBundle.length; i++) {
        const product = productosBundle[i];
        const cantidad = cantidades[i];

        if (isSimpleProduct(product)) {
          sumaSimples += parseFloat(product.variants[0].price) * cantidad;
        }
      }

      console.log("Suma de simples:", sumaSimples);

      for (const value1 of values1) {
        for (const value2 of values2) {
          console.log("-".repeat(50));

          console.log("Opción 1:", value1);
          console.log("Opción 2:", value2);

          let priceTotal = 0;

          const productoDeterminaVariante = productosBundle.find(
            (p) =>
              p.variants.some(
                (v) => v.option1 === value1 && v.option2 === value2
              ) &&
              p.id === idProduct1 &&
              p.id === idProduct2
          );

          if (productoDeterminaVariante) {
            console.log(
              "Producto determina variante:",
              productoDeterminaVariante.title
            );

            let precioDeterminaVariante =
              productoDeterminaVariante.variants.find(
                (v) => v.option1 === value1 && v.option2 === value2
              ).price;

            console.log("Precio determina variante:", precioDeterminaVariante);

            priceTotal += parseFloat(precioDeterminaVariante);
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

            if (producto1) {
              console.log("Producto 1:", producto1.title);
            }
            if (producto2) {
              console.log("Producto 2:", producto2.title);
            }

            const precioDeterminaVariante1 = producto1.variants.find(
              (v) => v.option1 === value1
            ).price;

            const precioDeterminaVariante2 = producto2.variants.find(
              (v) => v.option1 === value2
            ).price;

            console.log("Precio Variante 1:", precioDeterminaVariante1);
            console.log("Precio Variante 2:", precioDeterminaVariante2);

            priceTotal +=
              parseFloat(precioDeterminaVariante1) +
              parseFloat(precioDeterminaVariante2);
          }
          priceTotal += sumaSimples;

          variants.push({
            option1: value1,
            option2: value2,
            option3: null,
            price: priceTotal,
          });

          console.log("-".repeat(50));
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
      for (let i = 0; i < productosBundle.length; i++) {
        const product = productosBundle[i];
        const cantidad = cantidades[i];

        if (isSimpleProduct(product)) {
          sumaSimples += parseFloat(product.variants[0].price) * cantidad;
        }
      }

      for (const value1 of values1) {
        for (const value2 of values2) {
          for (const value3 of values3) {
            console.log("Opción 1:", value1);
            console.log("Opción 2:", value2);
            console.log("Opción 3:", value3);

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

            if (productoDeterminaVariante) {
              let precioDeterminaVariante =
                productoDeterminaVariante.variants.find(
                  (v) =>
                    v.option1 === value1 &&
                    v.option2 === value2 &&
                    v.option3 === value3 &&
                    p.id === idProduct1 &&
                    p.id === idProduct2 &&
                    p.id === idProduct3
                ).price;

              priceTotal += parseFloat(precioDeterminaVariante);
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
                console.log("Producto 1:", producto1.title);
                console.log("Producto 2:", product2.title);

                const precioDeterminaVariante1 = producto1.variants.find(
                  (v) =>
                    (v.option1 === value1 && v.option2 === value2) ||
                    (v.option1 === value1 && v.option3 === value3) ||
                    (v.option2 === value2 && v.option3 === value3)
                ).price;

                const precioDeterminaVariante2 = product2.variants.find(
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
                ).price;

                const cantidad1 =
                  cantidades[productosBundle.indexOf(producto1)];
                const cantidad2 = cantidades[productosBundle.indexOf(product2)];

                priceTotal +=
                  parseFloat(precioDeterminaVariante1) * cantidad1 +
                  parseFloat(precioDeterminaVariante2) * cantidad2;
              } else {
                let p1, p2, p3;

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
                  console.log("Producto 1:", p1.title);
                  precio1 = parseFloat(
                    p1.variants.find((v) => v.option1 === value1).price
                  );
                }

                if (p2) {
                  console.log("Producto 2:", p2.title);
                  precio2 = parseFloat(
                    p2.variants.find((v) => v.option1 === value2).price
                  );
                }

                if (p3) {
                  console.log("Producto 3:", p3.title);
                  precio3 = parseFloat(
                    p3.variants.find((v) => v.option1 === value3).price
                  );
                }

                priceTotal += precio1 + precio2 + precio3;
              }
            }

            priceTotal += sumaSimples;

            variants.push({
              option1: value1,
              option2: value2,
              option3: value3,
              price: priceTotal,
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
    console.log("Error validando el bundle:", error);

    return {
      validBundle: false,
      error: "Error validando el bundle",
      optionsOut: [],
    };
  }
}

async function isValidBundle(productId) {
  try {
    const bundle = await getProductById(productId);

    if (!bundle) {
      console.log("El bundle no existe en Shopify");
      return false;
    }

    const bundleFields = await getBundleFields(productId);
    if (!bundleFields) {
      console.log("El producto no tiene campos de bundle");
      return false;
    }

    const { productos, cantidades } = bundleFields;
    console.log("Productos:", productos);
    console.log("Cantidades:", cantidades);

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
      console.log("-".repeat(50));

      console.log("Producto: ", title);
      console.log("Cantidad: ", cantidad);

      if (!isSimpleProduct(product)) {
        optionsCount += opcionesProducto;
        if (variantsCount === 0) {
          variantsCount = variantesProducto;
        } else {
          variantsCount *= variantesProducto;
        }
      }

      if (optionsCount > 3) {
        console.log("El bundle tiene más de 3 opciones");
        return false;
      }

      if (variantsCount > 100) {
        console.log("El bundle tiene más de 100 variantes");
        return false;
      }
    }

    return true;
  } catch (error) {
    console.log("Error validando el bundle:", error);

    return {
      validBundle: false,
      error: "Error validando el bundle",
      optionsOut: [],
    };
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

async function handleProductUp(product) {
  try {
    const { id } = product;
    const bundleId = id;
    console.log("Manejando actualización del producto:", id);
    const p = await processProduct(product);

    console.log("Producto procesado:", p);

    const { validBundle, error, optionsOut, variantsOut } = await updateBundle(
      id
    );

    const updatePromises = [];

    if (validBundle) {
      const bundle = await getProductById(bundleId);
      const { options, variants } = bundle;
      console.log("El bundle es válido");
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

      // para los variants validar que su option1, option2, option3, y price sean iguales

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
        console.log("Hay cambios en las opciones o en las variantes");
        updatePromises.push(() =>
          shopify.product.update(bundleId, {
            options: optionsOut,
            variants: variantsOut,
          })
        );
      } else {
        console.log("No hay cambios en las opciones ni en las variantes");
      }
    } else {
      const optionDefault = [
        {
          name: "Title",
          values: ["Default Title"],
        },
      ];

      const variantDefault = [
        {
          option1: "Default Title",
          price: 0,
          title: "Default Title",
        },
      ];

      console.log("El bundle no es válido");

      updatePromises.push(() =>
        shopify.product.update(bundleId, {
          options: optionDefault,
          variants: variantDefault,
        })
      );
      console.log("Error:", error);
    }

    await processPromisesBatch(updatePromises);

    const updatePromises2 = [];

    const bundles = getBundlesDBWithProduct(bundleId);

    for (const bundle of bundles) {
      const id = bundle.productId;
      updatePromises2.push(() => handleProductUp(id));
    }

    await processPromisesBatch(updatePromises2);
  } catch (error) {
    console.log("Error actualizando el bundle:", error);
  }
}
async function processProduct(product) {
  try {
    const { id } = product;
    console.log("Procesando producto:", id);
    const bundleFields = await getBundleFields(id);

    console.log("Bundle Fields:", bundleFields);
    const productDb = await getProductDBById(id);

    const productData = {
      productId: product.id,
      title: product.title,
      ...bundleFields,
    };

    //console.log("Producto en MONGO:", productDb);
    //console.log("Producto en SHOPIFY:", productData);
    let pReturn = null;

    if (!productDb) {
      console.log("El producto no existe en MONGO, añadiendo...");
      const productAdded = await productService.saveProduct(productData);
      pReturn = productAdded;
    } else {
      console.log("El producto ya existe en MONGO, actualizando...");
      const productUpdated = await productService.updateProduct(
        id,
        productData
      );
      pReturn = productUpdated;
    }
    return {
      id: pReturn.productId,
      title: pReturn.title,
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
};
