const consts = require("../utils/products");
const productService = require("./productService");
const { retryWithBackoff } = require("../utils/functions");
const {
  getProductByIdGraphql,
  getProductCustomMetafieldsGraphql,
  updateProductGraphql,
  updateVariantPriceGraphql,
  getVariantWithInventoryGraphql,
  setInventoryLevelGraphql,
  batchSetInventoryLevelsGraphql,
  getDefaultLocationGraphql,
  getProductCountGraphql,
  listProductsGraphql,
} = require("./shopifyGraphql");
const { generateVariantCombinations, resolveInventoryReductions } = require("./variantGenerator");

// Set para rastrear productos actualmente en procesamiento (evitar loops infinitos)
const processingProducts = new Set();

async function actualizarVarianteProducto(variantId, price) {
  return await retryWithBackoff(() => updateVariantPriceGraphql(variantId, price));
}

async function productCount() {
  return retryWithBackoff(() => getProductCountGraphql());
}

async function getProductCustomMetafields(productId) {
  return retryWithBackoff(() => getProductCustomMetafieldsGraphql(productId));
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
    console.log(`[getBundleFields] Obteniendo metafields del producto ${productId}...`);
    const metafields = await getProductCustomMetafields(productId);
    console.log(`[getBundleFields] Metafields obtenidos: ${metafields.length} registros`);
    console.log(`[getBundleFields] Metafields:`, metafields.map(m => ({ key: m.key, namespace: m.namespace })));

    const listaProductosMetafield = metafields.find(
      (metafield) =>
        metafield.key === "lista_de_productos" &&
        metafield.namespace === "custom"
    );

    if (!listaProductosMetafield) {
      console.log(`[getBundleFields] No se encontró metafield 'lista_de_productos' para el producto ${productId}`);
      return {
        productos: [],
        cantidades: [],
      };
    }
    console.log(`[getBundleFields] Encontrado 'lista_de_productos': ${listaProductosMetafield.value}`);

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
    console.log(`[getBundleFields] Productos en el bundle (antes de validación): ${JSON.stringify(listaProductos)}`);

    // PROTECCIÓN: Detectar si el producto se incluye a sí mismo (referencia circular)
    if (listaProductos.includes(productId)) {
      console.error(
        `REFERENCIA CIRCULAR DETECTADA: El producto ${productId} se incluye a sí mismo en sus metafields.`
      );
      console.error(
        `   Esto causaría un loop infinito. Removiendo auto-referencia...`
      );
      // Filtrar la referencia circular
      listaProductos = listaProductos.filter((id) => id !== productId);
    }
    console.log(`[getBundleFields] Productos después de validación: ${JSON.stringify(listaProductos)}`);

    let listaCantidad = listaCantidadMetafield
      ? JSON.parse(listaCantidadMetafield.value).map((cantidad) =>
          parseFloat(cantidad)
        )
      : Array(listaProductos.length).fill(1);

    if (listaCantidad.length !== listaProductos.length) {
      console.warn(`[getBundleFields] Mismatch entre cantidad de productos (${listaProductos.length}) y cantidades (${listaCantidad.length}). Usando cantidades por defecto (1).`);
      listaCantidad = Array(listaProductos.length).fill(1);
    }
    console.log(`[getBundleFields] Cantidades: ${JSON.stringify(listaCantidad)}`);

    const opcionesVinculadasMetafield = metafields.find(
      (metafield) =>
        metafield.key === "opciones_vinculadas" &&
        metafield.namespace === "custom"
    );
    const opcionesVinculadas = opcionesVinculadasMetafield
      ? (JSON.parse(opcionesVinculadasMetafield.value).data ?? [])
      : [];

    console.log(`[getBundleFields] Bundle fields retornados: ${listaProductos.length} productos, ${opcionesVinculadas.length} opciones vinculadas`);
    return {
      productos: listaProductos,
      cantidades: listaCantidad,
      opcionesVinculadas,
    };
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      console.log(`[getBundleFields] Producto ${productId} no encontrado en Shopify`);
      return {
        productos: [],
        cantidades: [],
        opcionesVinculadas: [],
      };
    }
    console.error(`[getBundleFields] Error obteniendo bundle fields para producto ${productId}:`, error.message);
    return {
      productos: [],
      cantidades: [],
      opcionesVinculadas: [],
    };
  }
}

async function getProductById(productId) {
  try {
    return await retryWithBackoff(() => getProductByIdGraphql(productId));
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`[getProductById] Producto ${productId} no encontrado en Shopify`);
      return null;
    }
    if (error.response && error.response.status === 403) {
      console.error(
        `[getProductById] 403 Forbidden para producto ${productId}. Verifica ACCESS_TOKEN y permisos.`
      );
      return null;
    }
    console.error(
      `[getProductById] Error obteniendo producto ${productId}:`,
      error.message
    );
    return null;
  }
}

async function updateBundle(productId) {
  try {
    console.log(`\n========== PROCESANDO BUNDLE ${productId} ==========`);
    const bundle = await getProductById(productId);
    console.log(`[updateBundle] Producto obtenido: ${bundle ? bundle.title : 'null'}`);

    if (!bundle) {
      console.log(`[updateBundle] Bundle ${productId} no existe en Shopify`);
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
      console.log(`[updateBundle] No se obtuvieron bundle fields para ${productId}`);
      return {
        validBundle: false,
        error: "El producto no tiene campos de bundle, es un producto normal",
        optionsOut: [],
        variantsOut: [],
        isNormal: true,
      };
    }

    const { productos, cantidades, opcionesVinculadas } = bundleFields;
    console.log(`[updateBundle] Bundle fields: ${productos.length} productos, cantidades: ${JSON.stringify(cantidades)}, ${opcionesVinculadas.length} opciones vinculadas`);

    if (productos.length === 0) {
      console.log(`[updateBundle] El bundle no tiene productos configurados (productos array vacío)`);
      return {
        validBundle: false,
        error:
          "El producto no tiene productos en el bundle, por lo tano es un producto normal",
        optionsOut: [],
        variantsOut: [],
        isNormal: true,
      };
    }
    console.log(`[updateBundle] Bundle válido con ${productos.length} productos`);

    console.log(`[updateBundle] Obteniendo datos de ${productos.length} productos componentes...`);
    const productosPromises = productos.map((id) => {
      return () => getProductById(id);
    });
    const productosBundle = await processPromisesBatch(productosPromises);
    console.log(`[updateBundle] Productos componentes obtenidos: ${productosBundle.length} registros`);
    productosBundle.forEach((p, idx) => {
      if (p) {
        console.log(`  [${idx}] ${p.title} - ${p.variants.length} variantes`);
      } else {
        console.log(`  [${idx}] null (producto no encontrado)`);
      }
    });

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
    console.log(`[updateBundle] All simple products: ${allSimple}`);

    if (allSimple && opcionesVinculadas.length === 0) {
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
              productOptionPosition: j,   // qué opción dentro del producto (0=option1, 1=option2…)
              productCopyIndex: i,        // qué copia del producto (0..cantidad-1)
            };

            optionsOut.push(optionOut);
          }
        }
      }
      if (optionsCount > 3) {
        return {
          validBundle: false,
          error: "El bundle tiene más de 3 opciones (límite de Shopify)",
          optionsOut: [],
          variantsOut: [],
          isNormal: false,
        };
      }
      if (variantsCount > 1500) {
        console.warn(`[updateBundle] ⚠️ Bundle ${productId} generaría ${variantsCount} variantes (>1500, acercándose al límite de 2048)`);
      }
      if (variantsCount > 2048) {
        return {
          validBundle: false,
          error: `El bundle tiene más de 2048 variantes (${variantsCount})`,
          optionsOut: [],
          variantsOut: [],
          isNormal: false,
        };
      }
    }

    // Agregar opciones vinculadas a productos independientes
    if (opcionesVinculadas.length > 0) {
      const linkedProductIds = opcionesVinculadas.flatMap((ov) => ov.productos);
      const linkedProductsAll = await processPromisesBatch(
        linkedProductIds.map((id) => () => getProductById(id))
      );
      const linkedProductMap = new Map();
      linkedProductIds.forEach((id, idx) => {
        if (linkedProductsAll[idx]) linkedProductMap.set(id, linkedProductsAll[idx]);
      });

      for (const ov of opcionesVinculadas) {
        const linkedProducts = ov.productos.map((id) => linkedProductMap.get(id)).filter(Boolean);
        optionsOut.push({
          name: ov.nombre,
          values: ov.valores,
          isProductLinked: true,
          linkedProducts,
        });
        optionsCount += 1;
        if (variantsCount === 0) {
          variantsCount = ov.valores.length;
        } else {
          variantsCount *= ov.valores.length;
        }
        if (optionsCount > 3) {
          return {
            validBundle: false,
            error: "El bundle tiene más de 3 opciones (límite de Shopify)",
            optionsOut: [],
            variantsOut: [],
            isNormal: false,
          };
        }
        if (variantsCount > 1500) {
          console.warn(`[updateBundle] ⚠️ Bundle ${productId} generaría ${variantsCount} variantes (>1500, acercándose al límite de 2048)`);
        }
        if (variantsCount > 2048) {
          return {
            validBundle: false,
            error: `El bundle tiene más de 2048 variantes (${variantsCount})`,
            optionsOut: [],
            variantsOut: [],
            isNormal: false,
          };
        }
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
    variantsOut = generateVariantCombinations(optionsOut, productosBundle, cantidades);

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

      if (variantsCount > 2048) {
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

/**
 * Construye el optionsOut CON metadata (productOriginalId, productCopyIndex,
 * productOptionPosition) para un bundle complejo. A diferencia de updateBundle,
 * no descarta el metadata al final — necesario para resolveInventoryReductions.
 *
 * @returns {{ optionsOut, productosBundle, cantidades, productos } | null}
 */
async function buildBundleOptionsData(product_id) {
  const { productos, cantidades, opcionesVinculadas } = await getBundleFields(product_id);
  if (!productos.length) return null;

  const productosBundle = await processPromisesBatch(
    productos.map((id) => () => getProductById(id))
  );

  const optionsRaw = [];
  for (let i = 0; i < productosBundle.length; i++) {
    const product = productosBundle[i];
    if (!product || isSimpleProduct(product)) continue;

    const { options, title, id } = product;
    const cantidad = cantidades[i];

    for (let copy = 0; copy < cantidad; copy++) {
      for (let j = 0; j < options.length; j++) {
        optionsRaw.push({
          name: `${title} (${options[j].name})`,
          values: options[j].values,
          productOriginalTitle: title,
          productOriginalId: id,
          productOptionPosition: j,
          productCopyIndex: copy,
        });
      }
    }
  }

  // Agregar opciones vinculadas con sus productos cargados
  if (opcionesVinculadas.length > 0) {
    const linkedProductIds = opcionesVinculadas.flatMap((ov) => ov.productos);
    const linkedProductsAll = await processPromisesBatch(
      linkedProductIds.map((id) => () => getProductById(id))
    );
    const linkedProductMap = new Map();
    linkedProductIds.forEach((id, idx) => {
      if (linkedProductsAll[idx]) linkedProductMap.set(id, linkedProductsAll[idx]);
    });

    for (const ov of opcionesVinculadas) {
      const linkedProducts = ov.productos.map((id) => linkedProductMap.get(id)).filter(Boolean);
      optionsRaw.push({
        name: ov.nombre,
        values: ov.valores,
        isProductLinked: true,
        linkedProducts,
      });
    }
  }

  return {
    optionsOut: makeTitlesUnique(optionsRaw),
    productosBundle,
    cantidades,
    productos,
  };
}

async function handleProductUp(pId) {
  // PROTECCIÓN: Evitar procesamiento recursivo del mismo producto
  if (processingProducts.has(pId)) {
    console.warn(
      `⚠️ LOOP DETECTADO: El producto ${pId} ya está siendo procesado. Saltando para evitar recursión infinita.`
    );
    return;
  }

  // Marcar producto como en procesamiento
  processingProducts.add(pId);

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
            await updateProductGraphql(bundleId, optionsOut, variantsOut);
          });
        }
      } else {
        console.log(
          "El producto",
          bundleId,
          "no es un producto normal, pero tampoco es un bundle válido"
        );
        updatePromises.push(async () => {
          await updateProductGraphql(
            bundleId,
            [{ name: "Title", values: ["Default Title"] }],
            [{ option1: "Default Title", option2: null, option3: null, price: 0 }]
          );
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
          const locationGid = await getDefaultLocationGraphql();
          if (locationGid) {
            const quantities = [];
            for (let i = 0; i < variantsOut.length; i++) {
              const variantOut = variantsOut[i];
              const variant = variants[i];
              const targetQty = parseInt(variantOut.inventory_quantity);
              const actualQty = parseInt(variant.inventory_quantity);
              if (
                variant.inventory_management === "shopify" &&
                targetQty !== actualQty &&
                variant.inventoryItemId
              ) {
                quantities.push({ inventoryItemId: variant.inventoryItemId, quantity: targetQty });
              }
            }
            if (quantities.length > 0) {
              console.log(`Actualizando inventarios del bundle ${bundleId} (${quantities.length} variantes en batch)`);
              await batchSetInventoryLevelsGraphql(quantities, locationGid);
              console.log(`Inventarios del bundle ${bundleId} actualizados`);
            }
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
        // PROTECCIÓN: No actualizar si es el mismo producto (evitar ciclo)
        if (id !== bundleId) {
          updatePromises2.push(() => handleProductUp(id));
        } else {
          console.warn(
            `⚠️ CICLO EVITADO: Bundle ${id} se contiene a sí mismo. No se procesará recursivamente.`
          );
        }
      }
      await processPromisesBatch(updatePromises2);
    }
  } catch (error) {
    console.log("Error en handleProductUp:", error);
  } finally {
    // SIEMPRE remover el producto del set de procesamiento
    processingProducts.delete(pId);
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
  return retryWithBackoff(() => listProductsGraphql());
}

/**
 * Selecciona la ubicación de inventario a modificar.
 * Prefiere la primera ubicación con stock > 0; si ninguna tiene, usa la primera.
 */
function selectInventoryLevel(inventoryLevels) {
  if (!inventoryLevels || inventoryLevels.length === 0) return null;
  const withStock = inventoryLevels.find((l) => l.available > 0);
  return withStock || inventoryLevels[0];
}

async function reducirInventario(variantId, quantityToReduce) {
  try {
    const q = parseInt(quantityToReduce);
    const variantInfo = await retryWithBackoff(() =>
      getVariantWithInventoryGraphql(variantId)
    );

    if (!variantInfo || !variantInfo.inventory_management) {
      console.log("El producto no tiene inventario");
      return;
    }

    const level = selectInventoryLevel(variantInfo.inventoryLevels);
    if (!level) return;

    await retryWithBackoff(() =>
      setInventoryLevelGraphql(
        variantInfo.inventoryItemGid,
        level.locationGid,
        level.available - q
      )
    );
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
  }
}

async function aumentarInventario(variantId, quantityToAdd) {
  try {
    const q = parseInt(quantityToAdd);
    const variantInfo = await retryWithBackoff(() =>
      getVariantWithInventoryGraphql(variantId)
    );

    if (!variantInfo || !variantInfo.inventory_management) {
      console.log("El producto no tiene inventario");
      return;
    }

    const level = selectInventoryLevel(variantInfo.inventoryLevels);
    if (!level) return;

    await retryWithBackoff(() =>
      setInventoryLevelGraphql(
        variantInfo.inventoryItemGid,
        level.locationGid,
        level.available + q
      )
    );
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
  }
}

async function setInventoryLevel(variantId, quantity) {
  try {
    const q = parseInt(quantity);
    const variantInfo = await retryWithBackoff(() =>
      getVariantWithInventoryGraphql(variantId)
    );

    if (!variantInfo || !variantInfo.inventory_management) {
      console.log("El producto no tiene inventario");
      return;
    }

    const level = selectInventoryLevel(variantInfo.inventoryLevels);
    if (!level) return;

    await retryWithBackoff(() =>
      setInventoryLevelGraphql(
        variantInfo.inventoryItemGid,
        level.locationGid,
        q
      )
    );
  } catch (error) {
    console.error("Error actualizando el inventario:", error);
    return null;
  }
}

async function recursiveProductDiscount(product_id, variant_id, quantity) {
  const productData = await getProductById(product_id);
  if (!productData) {
    console.log(`No se encontró el producto con id ${product_id}`);
    return;
  }

  if (!(await isValidBundle(product_id))) {
    console.log(`El producto ${productData.title} no es un bundle`);
    return;
  }

  const variantRecibida = productData.variants.find((v) => v.id === variant_id);
  const bundleData = await buildBundleOptionsData(product_id);
  if (!bundleData) return;

  const { optionsOut, productosBundle, cantidades } = bundleData;
  const updateProductsPromises = [];
  const processBundlesPromises = [];

  async function schedule(product, variant, c) {
    if (await isValidBundle(product.id)) {
      processBundlesPromises.push(() => recursiveProductDiscount(product.id, variant.id, c));
    } else if (variant.inventory_management === 'shopify') {
      updateProductsPromises.push(() => reducirInventario(variant.id, c));
    }
  }

  console.log('-'.repeat(50));

  if (isSimpleProduct(productData)) {
    console.log(`El producto ${productData.title} es un bundle simple`);
    for (let i = 0; i < productosBundle.length; i++) {
      const p = productosBundle[i];
      if (p) await schedule(p, p.variants[0], cantidades[i] * quantity);
    }
  } else {
    console.log(`El producto ${productData.title} es un bundle con opciones`);
    const soldValues = [
      variantRecibida?.option1 ?? null,
      variantRecibida?.option2 ?? null,
      variantRecibida?.option3 ?? null,
    ];
    // Componentes no-simples: identificar variante exacta por copia usando metadata
    for (const { product, variant } of resolveInventoryReductions(optionsOut, productosBundle, soldValues)) {
      await schedule(product, variant, quantity);
    }
    // Componentes simples dentro del bundle complejo
    for (let i = 0; i < productosBundle.length; i++) {
      const p = productosBundle[i];
      if (p && isSimpleProduct(p)) await schedule(p, p.variants[0], cantidades[i] * quantity);
    }
  }

  console.log('-'.repeat(50));

  if (updateProductsPromises.length !== 0) {
    console.log(`Procesando promesas de productos del producto ${productData.title}`);
    await processPromisesBatch(updateProductsPromises);
  }

  if (processBundlesPromises.length !== 0) {
    console.log(`Procesando promesas de bundles del producto ${productData.title}`);
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
};
