const axios = require("axios");
const config = require("../utils/config");
const https = require("https");
const { retryWithBackoff } = require("../utils/functions");

const { ACCESS_TOKEN, SHOP, SHOPIFY_API_VERSION, SKIP_SSL_VERIFY } = config;
const API_VERSION = SHOPIFY_API_VERSION || "2026-01";

// Normalizar SHOP en caso de que venga con .myshopify.com
const SHOP_NAME = SHOP.replace(".myshopify.com", "");
const GRAPHQL_URL = `https://${SHOP_NAME}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

if (String(SKIP_SSL_VERIFY).toLowerCase() === "true") {
  console.warn(
    "⚠️ ADVERTENCIA: SSL_VERIFY deshabilitado. Esto NO debe usarse en producción."
  );
}

console.log(`[GraphQL] Conectando a: ${GRAPHQL_URL}`);

function buildProductGid(productId) {
  return `gid://shopify/Product/${productId}`;
}

function parseNumericId(gid) {
  if (!gid || typeof gid !== "string") return null;
  const match = gid.match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

const getAxiosConfig = () => {
  const config = {
    headers: {
      "X-Shopify-Access-Token": ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
  };

  if (String(SKIP_SSL_VERIFY).toLowerCase() === "true") {
    config.httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });
  }

  return config;
};

async function graphqlRequest(query, variables = {}) {
  return retryWithBackoff(async () => {
    try {
      const response = await axios.post(
        GRAPHQL_URL,
        { query, variables },
        getAxiosConfig()
      );

      if (response.data && response.data.errors && response.data.errors.length) {
        const messages = response.data.errors.map((e) => e.message).join(" | ");
        throw new Error(messages);
      }

      return response.data.data;
    } catch (error) {
      if (error.response && error.response.status === 403) {
        console.error(
          `[GraphQL] 403 Forbidden - Verifica que ACCESS_TOKEN es válido y tiene permisos adecuados`
        );
        console.error(`[GraphQL] Token: ${ACCESS_TOKEN.substring(0, 10)}...`);
        console.error(`[GraphQL] Shop: ${SHOP}`);
      }
      throw error;
    }
  });
}

async function fetchProductVariants(productGid) {
  const variants = [];
  let hasNextPage = true;
  let after = null;

  const query = `
    query ProductVariants($id: ID!, $first: Int!, $after: String) {
      product(id: $id) {
        variants(first: $first, after: $after) {
          pageInfo {
            hasNextPage
            endCursor
          }
          nodes {
            id
            title
            price
            sku
            inventoryQuantity
            inventoryItem { id tracked }
            selectedOptions { name value }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await graphqlRequest(query, {
      id: productGid,
      first: 250,
      after,
    });

    if (!data || !data.product || !data.product.variants) break;

    const connection = data.product.variants;
    if (connection.nodes && connection.nodes.length) {
      variants.push(...connection.nodes);
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  return variants;
}

function mapProductToRestShape(product, variants) {
  if (!product) return null;

  const options = (product.options || []).map((opt) => ({
    name: opt.name,
    values: opt.values || [],
  }));

  const mappedVariants = (variants || []).map((variant) => {
    const selectedOptions = variant.selectedOptions || [];
    const optionValues = options.map((opt) => {
      const match = selectedOptions.find((so) => so.name === opt.name);
      return match ? match.value : null;
    });

    const inventoryManagement =
      variant.inventoryItem && variant.inventoryItem.tracked ? "shopify" : null;

    return {
      id: parseNumericId(variant.id),
      admin_graphql_api_id: variant.id,
      title: variant.title,
      price: variant.price,
      sku: variant.sku,
      option1: optionValues[0] || null,
      option2: optionValues[1] || null,
      option3: optionValues[2] || null,
      inventory_quantity: variant.inventoryQuantity ?? 0,
      inventory_management: inventoryManagement,
      selectedOptions: selectedOptions,
      inventoryItemId: variant.inventoryItem?.id ?? null,
    };
  });

  return {
    id: parseNumericId(product.id),
    admin_graphql_api_id: product.id,
    title: product.title,
    options,
    variants: mappedVariants,
  };
}

async function getProductByIdGraphql(productId) {
  const productGid = buildProductGid(productId);

  const query = `
    query ProductBase($id: ID!) {
      product(id: $id) {
        id
        title
        options { name values }
      }
    }
  `;

  const data = await graphqlRequest(query, { id: productGid });
  if (!data || !data.product) return null;

  const variants = await fetchProductVariants(productGid);
  return mapProductToRestShape(data.product, variants);
}

async function getProductCustomMetafieldsGraphql(productId) {
  const productGid = buildProductGid(productId);

  const query = `
    query ProductMetafields($id: ID!, $first: Int!, $after: String) {
      product(id: $id) {
        metafields(namespace: "custom", first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { namespace key value }
        }
      }
    }
  `;

  const metafields = [];
  let hasNextPage = true;
  let after = null;

  while (hasNextPage) {
    const data = await graphqlRequest(query, {
      id: productGid,
      first: 250,
      after,
    });

    if (!data || !data.product || !data.product.metafields) break;

    const connection = data.product.metafields;
    if (connection.nodes && connection.nodes.length) {
      metafields.push(...connection.nodes);
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  return metafields;
}

// ─── Helpers de GIDs ──────────────────────────────────────────────────────────

function buildVariantGid(variantId) {
  return `gid://shopify/ProductVariant/${variantId}`;
}

function buildInventoryItemGid(inventoryItemId) {
  return `gid://shopify/InventoryItem/${inventoryItemId}`;
}

// ─── Actualizar variante (precio) ─────────────────────────────────────────────

async function updateVariantPriceGraphql(variantId, price) {
  const id = typeof variantId === 'string' && variantId.startsWith('gid://')
    ? variantId
    : buildVariantGid(variantId);

  const mutation = `
    mutation UpdateVariantPrice($id: ID!, $price: Money!) {
      productVariantUpdate(input: { id: $id, price: $price }) {
        productVariant { id price }
        userErrors { field message }
      }
    }
  `;

  const data = await graphqlRequest(mutation, { id, price: String(price) });
  const errors = data?.productVariantUpdate?.userErrors;
  if (errors && errors.length) {
    throw new Error(errors.map((e) => e.message).join(' | '));
  }
  return data?.productVariantUpdate?.productVariant;
}

// ─── Actualizar producto con opciones y variantes (productSet) ────────────────

/**
 * Actualiza un bundle con el conjunto completo de opciones y variantes.
 * Usa productSet (API 2024-01+) que reemplaza todas las variantes de una vez.
 *
 * @param {number|string} productId  ID numérico o GID del producto
 * @param {Array} optionsOut         [{name, values: string[]}]
 * @param {Array} variantsOut        [{option1, option2, option3, price}]
 * @returns {Object} Producto actualizado en shape compatible con REST
 */
async function updateProductGraphql(productId, optionsOut, variantsOut) {
  const productGid = typeof productId === 'string' && productId.startsWith('gid://')
    ? productId
    : buildProductGid(productId);

  // productOptions: [{name, values: [{name, swatch?}]}]
  const productOptions = optionsOut.map((opt) => ({
    name: opt.name,
    values: opt.values.map((v, i) => ({
      name: v,
      ...(opt.hexcodes?.[i] ? { swatch: { color: opt.hexcodes[i] } } : {}),
    })),
  }));

  // variants: [{optionValues: [{optionName, name}], price}]
  const optionNames = optionsOut.map((o) => o.name);
  const variants = variantsOut.map((v) => {
    const slotValues = [v.option1, v.option2, v.option3];
    const optionValues = optionNames
      .map((name, i) => (slotValues[i] != null ? { optionName: name, name: slotValues[i] } : null))
      .filter(Boolean);
    return {
      optionValues,
      price: String(v.price),
    };
  });

  const mutation = `
    mutation productSet($synchronous: Boolean!, $productSet: ProductSetInput!) {
      productSet(synchronous: $synchronous, input: $productSet) {
        product {
          id title
          options { name values }
          variants(first: 250) {
            nodes {
              id
              selectedOptions { name value }
              price
              inventoryItem { id }
              inventoryQuantity
            }
          }
        }
        userErrors { field message code }
      }
    }
  `;

  const data = await graphqlRequest(mutation, {
    synchronous: true,
    productSet: {
      id: productGid,
      productOptions,
      variants,
    },
  });

  const errors = data?.productSet?.userErrors;
  if (errors && errors.length) {
    throw new Error(errors.map((e) => e.message).join(' | '));
  }

  const product = data?.productSet?.product;
  if (!product) return null;

  const variantNodes = product.variants?.nodes || [];
  const mappedProduct = mapProductToRestShape(product, variantNodes);
  return mappedProduct;
}

// ─── Obtener variante con info de inventario ──────────────────────────────────

/**
 * Obtiene una variante y sus niveles de inventario en una sola query.
 * Reemplaza getVariant() + getInventoryLevels() (dos llamadas REST → una GraphQL).
 *
 * @param {number|string} variantId  ID numérico o GID de la variante
 * @returns {{ inventory_management, inventoryItemGid, inventoryLevels: [{locationGid, available}] }}
 */
async function getVariantWithInventoryGraphql(variantId) {
  const id = typeof variantId === 'string' && variantId.startsWith('gid://')
    ? variantId
    : buildVariantGid(variantId);

  const query = `
    query GetVariantInventory($id: ID!) {
      productVariant(id: $id) {
        id
        inventoryItem {
          id
          tracked
          inventoryLevels(first: 10) {
            nodes {
              location { id }
              quantities(names: ["available"]) { name quantity }
            }
          }
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { id });
  const variant = data?.productVariant;
  if (!variant) return null;

  const item = variant.inventoryItem;
  const tracked = item?.tracked ?? false;

  const inventoryLevels = (item?.inventoryLevels?.nodes || []).map((node) => ({
    locationGid: node.location?.id,
    available: node.quantities?.find((q) => q.name === 'available')?.quantity ?? 0,
  }));

  return {
    inventory_management: tracked ? 'shopify' : null,
    inventoryItemGid: item?.id,
    inventoryLevels,
  };
}

// ─── Establecer nivel de inventario (cantidad absoluta) ───────────────────────

/**
 * Establece el inventario disponible de un item en una ubicación.
 * Reemplaza shopify.inventoryLevel.set().
 *
 * @param {string} inventoryItemGid  GID del InventoryItem
 * @param {string} locationGid       GID de la Location
 * @param {number} quantity          Cantidad absoluta a establecer
 */
async function setInventoryLevelGraphql(inventoryItemGid, locationGid, quantity) {
  const mutation = `
    mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { reason }
        userErrors { field message }
      }
    }
  `;

  const data = await graphqlRequest(mutation, {
    input: {
      name: 'available',
      quantities: [{ inventoryItemId: inventoryItemGid, locationId: locationGid, quantity }],
      reason: 'correction',
      ignoreCompareQuantity: true,
    },
  });

  const errors = data?.inventorySetQuantities?.userErrors;
  if (errors && errors.length) {
    throw new Error(errors.map((e) => e.message).join(' | '));
  }
}

// ─── Obtener primera ubicación del store ──────────────────────────────────────

let _defaultLocationGid = null;

async function getDefaultLocationGraphql() {
  if (_defaultLocationGid) return _defaultLocationGid;

  const query = `
    query { locations(first: 1) { nodes { id } } }
  `;
  const data = await graphqlRequest(query);
  _defaultLocationGid = data?.locations?.nodes?.[0]?.id ?? null;
  return _defaultLocationGid;
}

// ─── Actualizar inventario en batch ───────────────────────────────────────────

/**
 * Establece el inventario disponible de múltiples items en una sola llamada GraphQL.
 * Ideal para bundles con muchas variantes (evita throttling por llamadas individuales).
 *
 * @param {Array}  quantities  [{inventoryItemId: GID, quantity: number}]
 * @param {string} locationGid GID de la ubicación
 */
async function batchSetInventoryLevelsGraphql(quantities, locationGid) {
  if (!quantities || quantities.length === 0) return;

  const mutation = `
    mutation BatchSetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { reason }
        userErrors { field message }
      }
    }
  `;

  const CHUNK = 250;
  for (let i = 0; i < quantities.length; i += CHUNK) {
    const chunk = quantities.slice(i, i + CHUNK);
    const data = await graphqlRequest(mutation, {
      input: {
        name: 'available',
        quantities: chunk.map(({ inventoryItemId, quantity }) => ({
          inventoryItemId,
          locationId: locationGid,
          quantity,
        })),
        reason: 'correction',
        ignoreCompareQuantity: true,
      },
    });
    const errors = data?.inventorySetQuantities?.userErrors;
    if (errors && errors.length) {
      console.warn('[batchSetInventoryLevelsGraphql] Errores parciales:', errors);
    }
  }
}

// ─── Crear producto con inventario ────────────────────────────────────────────

const PRODUCT_SET_MUTATION = `
  mutation productSet($synchronous: Boolean!, $productSet: ProductSetInput!) {
    productSet(synchronous: $synchronous, input: $productSet) {
      product {
        id title
        options { name values }
        variants(first: 250) {
          nodes {
            id
            selectedOptions { name value }
            price
            inventoryItem { id tracked }
            inventoryQuantity
          }
        }
      }
      userErrors { field message code }
    }
  }
`;

const BULK_CREATE_VARIANTS_MUTATION = `
  mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants {
        id
        selectedOptions { name value }
        price
        inventoryItem { id tracked }
        inventoryQuantity
      }
      userErrors { field message }
    }
  }
`;

/**
 * Crea un producto nuevo en Shopify.
 * Acepta el mismo formato que la REST API (shopify.product.create).
 *
 * Para productos con más de 100 variantes, crea el producto con las primeras 100
 * y agrega el resto en lotes de 100 via productVariantsBulkCreate.
 * Todo el inventario se establece en una sola llamada al final.
 *
 * @param {{ title, status, options?, variants }} productData
 *   options?: [{name: string}]
 *   variants: [{option1?, option2?, option3?, price, inventory_management?, inventory_quantity?}]
 * @returns {Object} Producto creado en shape compatible con REST
 */
async function createProductGraphql({ title, status = 'draft', options, variants = [] }) {
  const CHUNK = 100;
  const gqlStatus = status.toUpperCase();
  const isSimple = !options || options.length === 0;

  // Construir productOptions
  let productOptions;
  if (isSimple) {
    productOptions = [{ name: 'Title', values: [{ name: 'Default Title' }] }];
  } else {
    productOptions = options.map((opt, i) => {
      const optionKey = `option${i + 1}`;
      const uniqueValues = [...new Set(variants.map((v) => v[optionKey]).filter(Boolean))];
      return { name: opt.name, values: uniqueValues.map((v) => ({ name: v })) };
    });
  }

  const optionNames = productOptions.map((o) => o.name);

  const toGqlVariant = (v) => ({
    optionValues: isSimple
      ? [{ optionName: 'Title', name: 'Default Title' }]
      : optionNames
          .map((name, i) => {
            const val = v[`option${i + 1}`];
            return val != null ? { optionName: name, name: val } : null;
          })
          .filter(Boolean),
    price: String(v.price ?? '0.00'),
  });

  const gqlVariants = variants.map(toGqlVariant);

  // ── Paso 1: crear producto con las primeras CHUNK variantes ──────────────
  const firstChunk = gqlVariants.slice(0, CHUNK);
  const data = await graphqlRequest(PRODUCT_SET_MUTATION, {
    synchronous: true,
    productSet: { title, status: gqlStatus, productOptions, variants: firstChunk },
  });

  const setErrors = data?.productSet?.userErrors;
  if (setErrors && setErrors.length) {
    throw new Error(setErrors.map((e) => e.message).join(' | '));
  }

  const product = data?.productSet?.product;
  if (!product) return null;

  const allVariantNodes = [...(product.variants?.nodes || [])];

  // ── Paso 2: agregar variantes restantes en lotes de CHUNK ────────────────
  const remaining = gqlVariants.slice(CHUNK);
  for (let i = 0; i < remaining.length; i += CHUNK) {
    const batch = remaining.slice(i, i + CHUNK);
    const bulkData = await graphqlRequest(BULK_CREATE_VARIANTS_MUTATION, {
      productId: product.id,
      variants: batch,
    });
    const bulkErrors = bulkData?.productVariantsBulkCreate?.userErrors;
    if (bulkErrors && bulkErrors.length) {
      throw new Error(bulkErrors.map((e) => e.message).join(' | '));
    }
    allVariantNodes.push(...(bulkData?.productVariantsBulkCreate?.productVariants || []));
  }

  // ── Paso 3: establecer todo el inventario en una sola llamada ────────────
  const locationId = await getDefaultLocationGraphql();
  if (locationId) {
    const quantities = [];

    for (const gqlVariant of allVariantNodes) {
      const matchingInput = isSimple
        ? variants[0]
        : variants.find((v) =>
            gqlVariant.selectedOptions.every((so, i) => so.value === v[`option${i + 1}`])
          );

      if (
        matchingInput &&
        matchingInput.inventory_management === 'shopify' &&
        matchingInput.inventory_quantity != null
      ) {
        const inventoryItemId = gqlVariant.inventoryItem?.id;
        if (inventoryItemId) {
          quantities.push({ inventoryItemId, locationId, quantity: matchingInput.inventory_quantity });
        }
      }
    }

    if (quantities.length > 0) {
      const setInvMutation = `
        mutation SetInventoryBatch($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup { reason }
            userErrors { field message }
          }
        }
      `;
      const invData = await graphqlRequest(setInvMutation, {
        input: { name: 'available', quantities, reason: 'correction', ignoreCompareQuantity: true },
      });
      const invErrors = invData?.inventorySetQuantities?.userErrors;
      if (invErrors && invErrors.length) {
        console.warn('[createProductGraphql] Inventario parcialmente fallido:', invErrors);
      }
    }
  }

  return mapProductToRestShape(product, allVariantNodes);
}

// ─── Eliminar producto ────────────────────────────────────────────────────────

async function deleteProductGraphql(productId) {
  const id = typeof productId === 'string' && productId.startsWith('gid://')
    ? productId
    : buildProductGid(productId);

  const mutation = `
    mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }
  `;

  const data = await graphqlRequest(mutation, { input: { id } });
  const errors = data?.productDelete?.userErrors;
  if (errors && errors.length) {
    throw new Error(errors.map((e) => e.message).join(' | '));
  }
  return data?.productDelete?.deletedProductId;
}

// ─── Contar productos ─────────────────────────────────────────────────────────

async function getProductCountGraphql() {
  const query = `query { productsCount { count } }`;
  const data = await graphqlRequest(query);
  return data?.productsCount?.count ?? 0;
}

// ─── Productos con precio 0 ───────────────────────────────────────────────────

/**
 * Obtiene todos los productos de la tienda que tienen al menos una variante con precio 0.
 * Usa el filtro "variant.price:0" de la API de Shopify.
 *
 * @returns {Array} [{id, admin_graphql_api_id, title, zeroVariants: [{id, title, price}]}]
 */
async function listProductsWithZeroPriceGraphql() {
  const allProducts = [];
  let hasNextPage = true;
  let after = null;

  const query = `
    query ProductsWithZeroPrice($first: Int!, $after: String) {
      products(first: $first, after: $after, query: "variant.price:0") {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          title
          variants(first: 250) {
            nodes {
              id
              title
              price
            }
          }
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await graphqlRequest(query, { first: 250, after });
    if (!data || !data.products) break;

    const connection = data.products;

    for (const product of connection.nodes || []) {
      const zeroVariants = (product.variants?.nodes || []).filter(
        (v) => parseFloat(v.price) === 0
      );
      allProducts.push({
        id: parseNumericId(product.id),
        admin_graphql_api_id: product.id,
        title: product.title,
        zeroVariants: zeroVariants.map((v) => ({
          id: parseNumericId(v.id),
          admin_graphql_api_id: v.id,
          title: v.title,
          price: v.price,
        })),
      });
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  return allProducts;
}

// ─── Listar todos los productos (paginado) ────────────────────────────────────

async function listProductsGraphql() {
  const allProducts = [];
  let hasNextPage = true;
  let after = null;

  const query = `
    query ListProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title
          options { name values }
        }
      }
    }
  `;

  while (hasNextPage) {
    const data = await graphqlRequest(query, { first: 250, after });
    if (!data || !data.products) break;

    const connection = data.products;

    for (const product of connection.nodes || []) {
      const variants = await fetchProductVariants(product.id);
      const mapped = mapProductToRestShape(product, variants);
      if (mapped) allProducts.push(mapped);
    }

    hasNextPage = connection.pageInfo.hasNextPage;
    after = connection.pageInfo.endCursor;
  }

  return allProducts;
}

module.exports = {
  graphqlRequest,
  buildVariantGid,
  buildInventoryItemGid,
  getProductByIdGraphql,
  getProductCustomMetafieldsGraphql,
  updateProductGraphql,
  updateVariantPriceGraphql,
  getVariantWithInventoryGraphql,
  setInventoryLevelGraphql,
  batchSetInventoryLevelsGraphql,
  getDefaultLocationGraphql,
  createProductGraphql,
  deleteProductGraphql,
  getProductCountGraphql,
  listProductsGraphql,
  listProductsWithZeroPriceGraphql,
};
