const axios = require("axios");
const config = require("../utils/config");
const https = require("https");

const { ACCESS_TOKEN, SHOP, SHOPIFY_API_VERSION, SKIP_SSL_VERIFY } = config;
const API_VERSION = SHOPIFY_API_VERSION || "2026-01";
const GRAPHQL_URL = `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

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
    console.warn(
      "⚠️ ADVERTENCIA: SSL_VERIFY deshabilitado. Esto NO debe usarse en producción."
    );
    config.httpsAgent = new https.Agent({
      rejectUnauthorized: false,
    });
  }

  return config;
};

async function graphqlRequest(query, variables = {}) {
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
            inventoryItem { tracked }
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

module.exports = {
  graphqlRequest,
  getProductByIdGraphql,
  getProductCustomMetafieldsGraphql,
};
