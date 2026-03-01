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
  listProductsWithZeroPriceGraphql,
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
      const { productos, productosVinculados } = product;
      return productos.includes(id) || (productosVinculados && productosVinculados.includes(id));
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
        opcionesVinculadas: [],
        opcionColor: null,
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

    let opcionesVinculadas = [];
    const nombreMf = metafields.find(m => m.key === 'opcion_vinculada_nombre' && m.namespace === 'custom');
    const etiquetasMf = metafields.find(m => m.key === 'opcion_vinculada_etiquetas' && m.namespace === 'custom');
    const productosMf = metafields.find(m => m.key === 'opcion_vinculada_productos' && m.namespace === 'custom');

    if (nombreMf && etiquetasMf && productosMf) {
      const productoIds = JSON.parse(productosMf.value)
        .map(gid => parseInt(gid.match(/\/(\d+)$/)[1], 10));
      const etiquetas = JSON.parse(etiquetasMf.value);

      if (etiquetas.length === productoIds.length) {
        opcionesVinculadas = [{ nombre: nombreMf.value, valores: etiquetas, productos: productoIds }];
      } else {
        console.warn(`[getBundleFields] Mismatch etiquetas(${etiquetas.length}) vs productos(${productoIds.length})`);
      }
    }

    let opcionColor = null;
    const colorNombreMf = metafields.find(m => m.key === 'opcion_color_nombre' && m.namespace === 'custom');
    const colorEtiquetasMf = metafields.find(m => m.key === 'opcion_color_etiquetas' && m.namespace === 'custom');
    const colorProductosMf = metafields.find(m => m.key === 'opcion_color_productos' && m.namespace === 'custom');
    const colorOpcionesNumeroMf = metafields.find(m => m.key === 'opcion_color_opciones_numero' && m.namespace === 'custom');

    if (colorNombreMf && colorEtiquetasMf && colorProductosMf && colorOpcionesNumeroMf) {
      const colorProductIds = JSON.parse(colorProductosMf.value)
        .map(gid => parseInt(gid.match(/\/(\d+)$/)[1], 10));
      const colorEtiquetas = JSON.parse(colorEtiquetasMf.value);
      const colorOpcionesNumero = JSON.parse(colorOpcionesNumeroMf.value);
      if (colorEtiquetas.length === colorProductIds.length) {
        opcionColor = {
          nombre: colorNombreMf.value,
          valores: colorEtiquetas,
          productos: colorProductIds,
          opcionesNumero: colorOpcionesNumero,
        };
      } else {
        console.warn(`[getBundleFields] Mismatch color etiquetas(${colorEtiquetas.length}) vs productos(${colorProductIds.length})`);
      }
    }

    console.log(`[getBundleFields] Bundle fields retornados: ${listaProductos.length} productos, ${opcionesVinculadas.length} opciones vinculadas, ${opcionColor ? 'con opcionColor' : 'sin opcionColor'}`);
    return {
      productos: listaProductos,
      cantidades: listaCantidad,
      opcionesVinculadas,
      opcionColor,
    };
  } catch (error) {
    if (error.response && error.response.statusCode === 404) {
      console.log(`[getBundleFields] Producto ${productId} no encontrado en Shopify`);
      return {
        productos: [],
        cantidades: [],
        opcionesVinculadas: [],
        opcionColor: null,
      };
    }
    console.error(`[getBundleFields] Error obteniendo bundle fields para producto ${productId}:`, error.message);
    return null;
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

async function fetchLinkedProductOptions(opcionesVinculadas, callerName) {
  const linkedProductIds = opcionesVinculadas.flatMap((ov) => ov.productos);
  const linkedProductsAll = await processPromisesBatch(
    linkedProductIds.map((id) => () => getProductById(id))
  );
  const linkedProductMap = new Map();
  linkedProductIds.forEach((id, idx) => {
    if (linkedProductsAll[idx]) linkedProductMap.set(id, linkedProductsAll[idx]);
  });

  const options = [];
  for (const ov of opcionesVinculadas) {
    const linkedProducts = [];
    for (const id of ov.productos) {
      const p = linkedProductMap.get(id) ?? null;
      if (p && !isSimpleProduct(p)) {
        console.error(`[${callerName}] Producto vinculado ${id} ("${p.title}") no es simple (tiene opciones/variantes). No se puede procesar el bundle.`);
        return null;
      }
      linkedProducts.push(p);
    }
    options.push({
      name: ov.nombre,
      values: ov.valores,
      isProductLinked: true,
      linkedProducts,
    });
  }
  return options;
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

    const { productos, cantidades, opcionesVinculadas, opcionColor } = bundleFields;
    console.log(`[updateBundle] Bundle fields: ${productos.length} productos, cantidades: ${JSON.stringify(cantidades)}, ${opcionesVinculadas.length} opciones vinculadas, ${opcionColor ? 'con opcionColor' : 'sin opcionColor'}`);

    if (productos.length === 0 && !opcionColor) {
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

    if (allSimple && opcionesVinculadas.length === 0 && !opcionColor) {
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
      const linkedOptions = await fetchLinkedProductOptions(opcionesVinculadas, 'updateBundle');
      if (!linkedOptions) {
        return {
          validBundle: false,
          error: "Un producto vinculado tiene opciones/variantes. Solo se permiten productos simples.",
          optionsOut: [],
          variantsOut: [],
          isNormal: false,
        };
      }
      for (const opt of linkedOptions) {
        optionsOut.push(opt);
        optionsCount += 1;
        if (variantsCount === 0) {
          variantsCount = opt.values.length;
        } else {
          variantsCount *= opt.values.length;
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

    // Agregar opciones de color (número × color cross-variant)
    if (opcionColor) {
      const colorProductsData = await processPromisesBatch(
        opcionColor.productos.map(id => () => getProductById(id))
      );
      const firstColorProduct = colorProductsData.find(p => p != null);
      if (!firstColorProduct) {
        return {
          validBundle: false,
          error: "No se pudo obtener ningún producto de color configurado",
          optionsOut: [],
          variantsOut: [],
          isNormal: false,
        };
      }
      const numValues = firstColorProduct.options[0].values;

      for (const numOpName of opcionColor.opcionesNumero) {
        optionsOut.push({
          name: numOpName,
          values: numValues,
          isColorNumero: true,
          colorOptionName: opcionColor.nombre,
        });
        optionsCount += 1;
        if (variantsCount === 0) {
          variantsCount = numValues.length;
        } else {
          variantsCount *= numValues.length;
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

      optionsOut.push({
        name: opcionColor.nombre,
        values: opcionColor.valores,
        isColorLinked: true,
        colorProducts: colorProductsData,
      });
      optionsCount += 1;
      if (variantsCount === 0) {
        variantsCount = opcionColor.valores.length;
      } else {
        variantsCount *= opcionColor.valores.length;
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
      isNormal: true,
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

    const { productos, cantidades, opcionColor } = bundleFields;

    if (productos.length === 0 && !opcionColor) {
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
      if (!product) continue;
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
  const bundleFields = await getBundleFields(product_id);
  if (!bundleFields || (!bundleFields.productos.length && !bundleFields.opcionColor)) return null;
  const { productos, cantidades, opcionesVinculadas, opcionColor } = bundleFields;

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
    const linkedOptions = await fetchLinkedProductOptions(opcionesVinculadas, 'buildBundleOptionsData');
    if (!linkedOptions) return null;
    optionsRaw.push(...linkedOptions);
  }

  // Agregar opciones de color (número × color cross-variant)
  if (opcionColor) {
    const colorProductsData = await processPromisesBatch(
      opcionColor.productos.map(id => () => getProductById(id))
    );
    const firstColorProduct = colorProductsData.find(p => p != null);
    if (!firstColorProduct) {
      console.error('[buildBundleOptionsData] No se pudo obtener ningún producto de color');
      return null;
    }
    const numValues = firstColorProduct.options[0].values;

    for (const numOpName of opcionColor.opcionesNumero) {
      optionsRaw.push({
        name: numOpName,
        values: numValues,
        isColorNumero: true,
        colorOptionName: opcionColor.nombre,
      });
    }
    optionsRaw.push({
      name: opcionColor.nombre,
      values: opcionColor.valores,
      isColorLinked: true,
      colorProducts: colorProductsData,
    });
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
        if (!bundle) {
          console.error(`[handleProductUp] No se pudo obtener el bundle ${bundleId} para comparar opciones/variantes. Saltando actualización.`);
          return;
        }
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
        if (!bundle) {
          console.error(`[handleProductUp] No se pudo obtener el bundle ${bundleId} para actualizar inventario. Saltando inventario.`);
          return;
        }
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

    if (!bundleFields) {
      console.warn(`[processProduct] Error leyendo metafields de ${id}, preservando datos existentes en MongoDB`);
      return null;
    }

    const productDb = await getProductDBById(id);

    const productData = {
      productId: id,
      ...bundleFields,
      productosVinculados: [
        ...(bundleFields.opcionesVinculadas || []).flatMap((ov) => ov.productos),
        ...(bundleFields.opcionColor ? bundleFields.opcionColor.productos : []),
      ],
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

async function getProductsWithZeroPrice() {
  return retryWithBackoff(() => listProductsWithZeroPriceGraphql());
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

async function recursiveProductDiscount(product_id, variant_id, quantity, depth = 0) {
  const indent = '  '.repeat(depth);

  const productData = await getProductById(product_id);
  if (!productData) {
    console.log(`${indent}[descuento] Producto ${product_id} no encontrado, se omite`);
    return;
  }

  console.log(`\n${indent}[descuento] "${productData.title}" (variant: ${variant_id}, qty: ${quantity})`);

  if (!(await isValidBundle(product_id))) {
    console.log(`${indent}[descuento] "${productData.title}" no es un bundle, se omite`);
    return;
  }

  const variantRecibida = productData.variants.find((v) => v.id === variant_id);
  if (!variantRecibida) {
    console.warn(`${indent}[descuento] Variante ${variant_id} no encontrada en "${productData.title}"`);
  }

  const bundleData = await buildBundleOptionsData(product_id);
  if (!bundleData) {
    console.error(`${indent}[descuento] No se pudo obtener datos del bundle "${productData.title}"`);
    return;
  }

  const { optionsOut, productosBundle, cantidades } = bundleData;
  const updateProductsPromises = [];
  const processBundlesPromises = [];

  async function schedule(product, variant, c) {
    if (await isValidBundle(product.id)) {
      console.log(`${indent}  → sub-bundle: "${product.title}" (variant: ${variant.id}, qty: ${c})`);
      processBundlesPromises.push(() => recursiveProductDiscount(product.id, variant.id, c, depth + 1));
    } else if (variant.inventory_management === 'shopify') {
      console.log(`${indent}  → inventario: "${product.title}" variant ${variant.id} -${c}`);
      updateProductsPromises.push(() => reducirInventario(variant.id, c));
    } else {
      console.log(`${indent}  → "${product.title}" sin gestión de inventario, se omite`);
    }
  }

  if (isSimpleProduct(productData)) {
    console.log(`${indent}[descuento] Bundle simple con ${productosBundle.length} componente(s)`);
    for (let i = 0; i < productosBundle.length; i++) {
      const p = productosBundle[i];
      if (p) await schedule(p, p.variants[0], cantidades[i] * quantity);
    }
  } else {
    const soldValues = [
      variantRecibida?.option1 ?? null,
      variantRecibida?.option2 ?? null,
      variantRecibida?.option3 ?? null,
    ];
    console.log(`${indent}[descuento] Bundle con opciones, variante vendida: [${soldValues.filter(Boolean).join(', ')}]`);
    // Componentes no-simples: identificar variante exacta por copia usando metadata
    for (const { product, variant } of resolveInventoryReductions(optionsOut, productosBundle, soldValues)) {
      await schedule(product, variant, quantity);
    }
    // Componentes simples dentro del bundle complejo
    for (let i = 0; i < productosBundle.length; i++) {
      const p = productosBundle[i];
      if (p && isSimpleProduct(p)) await schedule(p, p.variants[0], cantidades[i] * quantity);
    }

    // Opciones de color: por cada opción de número, descontar la variante correspondiente del producto de color
    const colorOptIdx = optionsOut.findIndex(o => o.isColorLinked);
    if (colorOptIdx !== -1) {
      const colorOpt = optionsOut[colorOptIdx];
      const soldColorValue = soldValues[colorOptIdx];
      if (soldColorValue != null) {
        const colorProductIdx = colorOpt.values.indexOf(soldColorValue);
        const colorProduct = colorOpt.colorProducts?.[colorProductIdx];
        if (colorProduct) {
          for (let i = 0; i < optionsOut.length; i++) {
            if (!optionsOut[i].isColorNumero) continue;
            const soldNumValue = soldValues[i];
            if (soldNumValue == null) continue;
            const colorVariant = colorProduct.variants.find(v =>
              v.option1 === soldNumValue || v.option2 === soldNumValue || v.option3 === soldNumValue
            );
            if (!colorVariant) {
              console.warn(`${indent}[descuento] Variante "${soldNumValue}" no encontrada en "${colorProduct.title}"`);
              continue;
            }
            console.log(`${indent}  → color-numero: "${colorProduct.title}" variante "${soldNumValue}" (variant: ${colorVariant.id}, qty: ${quantity})`);
            await schedule(colorProduct, colorVariant, quantity);
          }
        } else {
          console.warn(`${indent}[descuento] Producto de color para "${soldColorValue}" no encontrado`);
        }
      }
    }
  }

  if (updateProductsPromises.length > 0) {
    console.log(`${indent}[descuento] Reduciendo inventario de ${updateProductsPromises.length} producto(s)...`);
    await processPromisesBatch(updateProductsPromises);
  }

  if (processBundlesPromises.length > 0) {
    console.log(`${indent}[descuento] Procesando ${processBundlesPromises.length} sub-bundle(s)...`);
    await processPromisesBatch(processBundlesPromises);
  }
}

async function handleOrderCreate(orderData) {
  try {
    const { id: orderId, line_items } = orderData;
    console.log(`\n========== PROCESANDO ORDEN ${orderId} (${line_items.length} items) ==========`);

    for (const lineItem of line_items) {
      const { product_id, variant_id, quantity, title } = lineItem;
      console.log(`[orden] → "${title}" (product: ${product_id}, variant: ${variant_id}, qty: ${quantity})`);
      await recursiveProductDiscount(product_id, variant_id, quantity);
    }

    console.log(`========== ORDEN ${orderId} PROCESADA ==========\n`);
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
  getProductsWithZeroPrice,
  reducirInventario,
  aumentarInventario,
  handleOrderCreate,
  recursiveProductDiscount,
  processProduct,
};
