'use strict';

/**
 * Genera el producto cartesiano de N arrays.
 * Ejemplo: cartesianProduct([['Rojo','Azul'], ['S','M']])
 *   → [['Rojo','S'], ['Rojo','M'], ['Azul','S'], ['Azul','M']]
 *
 * @param {Array[]} arrays - Array de arrays de valores
 * @returns {Array[]} Todas las combinaciones posibles
 */
function cartesianProduct(arrays) {
  if (arrays.length === 0) return [[]];
  const [head, ...tail] = arrays;
  const tailProduct = cartesianProduct(tail);
  const result = [];
  for (const value of head) {
    for (const combo of tailProduct) {
      result.push([value, ...combo]);
    }
  }
  return result;
}

/**
 * Verifica si un producto de Shopify es simple (sin variantes reales).
 */
function isSimpleProduct(product) {
  if (!product) return false;
  const { options, variants } = product;
  if (!variants || variants.length !== 1) return false;
  if (!options || options.length !== 1) return false;
  const opt = options[0];
  return opt.name === 'Title' && opt.values.length === 1 && opt.values[0] === 'Default Title';
}

/**
 * Encuentra la variante de un producto que coincide con los valores de opción seleccionados.
 *
 * @param {Object} product - Producto Shopify con .variants
 * @param {Array} selectedOptions - [{position: 0, value: 'Rojo'}, {position: 1, value: 'M'}]
 *   Donde position 0 → option1, 1 → option2, 2 → option3
 * @returns {Object|null} La variante coincidente, o null si no se encontró
 */
function findVariantForProductCopy(product, selectedOptions) {
  return product.variants.find((v) =>
    selectedOptions.every(({ position, value }) => {
      const optionKey = `option${position + 1}`;
      return v[optionKey] === value;
    })
  ) || null;
}

/**
 * Genera todas las combinaciones de variantes para un bundle de N opciones.
 *
 * Reemplaza la lógica hardcodeada de 1/2/3 opciones en updateBundle() con
 * un enfoque generalizado basado en producto cartesiano.
 *
 * Cómo funciona:
 * - Cada entrada en optionsOut tiene productOriginalId, productCopyIndex y
 *   productOptionPosition para saber a qué producto/copia/opción pertenece.
 * - Se agrupan los valores seleccionados por (productId, copyIndex) para
 *   encontrar la variante correcta en productos multi-opción.
 * - Los productos simples contribuyen un precio fijo × su cantidad.
 *
 * @param {Array} optionsOut - Opciones del bundle con estructura:
 *   [{
 *     name: string,
 *     values: string[],
 *     productOriginalId: number,
 *     productCopyIndex: number,       // qué copia del producto (0..cantidad-1)
 *     productOptionPosition: number,  // qué opción del producto (0=option1, 1=option2)
 *   }]
 * @param {Array} productosBundle - Productos componentes de Shopify
 * @param {Array} cantidades - Cantidad de cada producto en productosBundle
 * @returns {Array} Array de variantes: [{option1, option2, option3, price, inventory_management, inventory_quantity}]
 */
function generateVariantCombinations(optionsOut, productosBundle, cantidades) {
  const startTime = Date.now();

  // Contribución fija de productos simples (igual en todas las variantes)
  let sumaSimples = 0;
  let minInvSimples = Infinity;

  for (let i = 0; i < productosBundle.length; i++) {
    const product = productosBundle[i];
    if (!product) continue;
    const cantidad = cantidades[i];

    if (isSimpleProduct(product)) {
      sumaSimples += parseFloat(product.variants[0].price) * cantidad;
      const inv = product.variants[0].inventory_quantity;
      const mgmt = product.variants[0].inventory_management;
      if (mgmt === 'shopify' && cantidad > 0) {
        const invPerUnit = Math.floor(inv / cantidad);
        if (invPerUnit < minInvSimples) {
          minInvSimples = invPerUnit;
        }
      }
    }
  }

  // Generar todas las combinaciones de valores
  const valueArrays = optionsOut.map((opt) => opt.values);
  const combinations = cartesianProduct(valueArrays);

  console.log(`[variantGenerator] Calculando ${combinations.length} combinaciones para ${optionsOut.length} opciones`);

  const variants = combinations.map((optionValues) => {
    // Agrupar valores seleccionados por (productOriginalId, productCopyIndex)
    // Esto identifica qué valores pertenecen a la misma copia de un producto
    const productCopyGroups = new Map();

    for (let i = 0; i < optionsOut.length; i++) {
      const opt = optionsOut[i];
      if (opt.isProductLinked) continue;
      const key = `${opt.productOriginalId}:${opt.productCopyIndex}`;
      if (!productCopyGroups.has(key)) {
        productCopyGroups.set(key, {
          productId: opt.productOriginalId,
          selectedOptions: [],
        });
      }
      productCopyGroups.get(key).selectedOptions.push({
        position: opt.productOptionPosition,
        value: optionValues[i],
      });
    }

    // Calcular precio e inventario para esta combinación
    let priceTotal = sumaSimples;
    let minVar = Infinity;

    for (const [, group] of productCopyGroups) {
      const product = productosBundle.find((p) => p && p.id === group.productId);
      if (!product) continue;

      const variant = findVariantForProductCopy(product, group.selectedOptions);
      if (!variant) continue;

      // Cada copia contribuye el precio de su variante × 1 (una unidad por copia)
      priceTotal += parseFloat(variant.price);

      if (variant.inventory_management === 'shopify') {
        const inv = variant.inventory_quantity;
        if (inv < minVar) {
          minVar = Math.floor(inv);
        }
      }
    }

    // Precio e inventario de opciones vinculadas a productos independientes
    for (let i = 0; i < optionsOut.length; i++) {
      const opt = optionsOut[i];
      if (!opt.isProductLinked) continue;
      const linkedIdx = opt.values.indexOf(optionValues[i]);
      const linkedProduct = opt.linkedProducts?.[linkedIdx];
      if (!linkedProduct) continue;
      const v = linkedProduct.variants[0];
      if (!v) continue;
      priceTotal += parseFloat(v.price);
      if (v.inventory_management === 'shopify') {
        const inv = v.inventory_quantity;
        if (inv < minVar) minVar = Math.floor(inv);
      }
    }

    // Inventario final: mínimo entre variantes no-simples y simples
    let finalInv = Math.min(minVar, minInvSimples);
    if (finalInv === Infinity) finalInv = 0;

    return {
      option1: optionValues[0] || null,
      option2: optionValues[1] || null,
      option3: optionValues[2] || null,
      price: priceTotal,
      inventory_management: 'shopify',
      inventory_quantity: finalInv,
    };
  });

  const elapsed = Date.now() - startTime;
  console.log(`[variantGenerator] ${variants.length} variantes generadas en ${elapsed}ms`);

  return variants;
}

/**
 * Dado el optionsOut CON metadata y los valores de la variante vendida,
 * devuelve [{product, variant}] — uno por cada copia de componente no-simple
 * involucrada en esa combinación.
 *
 * Usa la misma lógica de agrupamiento que generateVariantCombinations:
 * agrupa por (productOriginalId, productCopyIndex) para identificar
 * exactamente qué variante de cada componente corresponde a cada slot del bundle.
 *
 * @param {Array} optionsOutWithMeta  optionsOut con productOriginalId, productCopyIndex, productOptionPosition
 * @param {Array} productosBundle     Productos componentes (shape REST)
 * @param {Array} soldOptionValues    [option1, option2, option3] de la variante vendida (null si no aplica)
 * @returns {Array} [{product, variant}]
 */
function resolveInventoryReductions(optionsOutWithMeta, productosBundle, soldOptionValues) {
  const groups = new Map();

  for (let i = 0; i < optionsOutWithMeta.length; i++) {
    const opt = optionsOutWithMeta[i];
    if (opt.isProductLinked) continue;
    const soldValue = soldOptionValues[i] ?? null;
    if (soldValue == null) continue;

    const key = `${opt.productOriginalId}:${opt.productCopyIndex}`;
    if (!groups.has(key)) {
      groups.set(key, { productId: opt.productOriginalId, selectedOptions: [] });
    }
    groups.get(key).selectedOptions.push({
      position: opt.productOptionPosition,
      value: soldValue,
    });
  }

  const result = [];
  for (const [, group] of groups) {
    const product = productosBundle.find((p) => p && p.id === group.productId);
    if (!product) continue;
    const variant = findVariantForProductCopy(product, group.selectedOptions);
    if (!variant) continue;
    result.push({ product, variant });
  }

  // Resolver opciones vinculadas a productos independientes
  for (let i = 0; i < optionsOutWithMeta.length; i++) {
    const opt = optionsOutWithMeta[i];
    if (!opt.isProductLinked) continue;
    const soldValue = soldOptionValues[i] ?? null;
    if (soldValue == null) continue;
    const linkedIdx = opt.values.indexOf(soldValue);
    const linkedProduct = opt.linkedProducts?.[linkedIdx];
    if (!linkedProduct) continue;
    const variant = linkedProduct.variants[0];
    if (!variant) continue;
    result.push({ product: linkedProduct, variant });
  }

  return result;
}

module.exports = {
  cartesianProduct,
  findVariantForProductCopy,
  generateVariantCombinations,
  resolveInventoryReductions,
};
