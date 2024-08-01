const config = require("./utils/config");
const Shopify = require("shopify-api-node");
const fs = require("fs");
const { ACCESS_TOKEN, SHOP, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES } =
  config;

// Configura Shopify API
const shopify = new Shopify({
  shopName: SHOP,
  apiKey: SHOPIFY_API_KEY,
  password: ACCESS_TOKEN,
});

// get products
async function listProducts() {
  try {
    const products = await shopify.product.list();
    console.log(products);
    return products;
  } catch (error) {
    console.error("Error fetching products:", error);
    throw error;
  }
}
// get product by id
async function getProduct(productId) {
  try {
    const product = await shopify.product.get(productId);
    console.log(product);
    return product;
  } catch (error) {
    console.error("Error fetching product:", error);
    throw error;
  }
}

// get metafields from a product
async function getProductMetafields(productId) {
  try {
    const metafields = await shopify.metafield.list({
      metafield: { owner_resource: "product", owner_id: productId },
    });
    console.log(metafields);
    return metafields;
  } catch (error) {
    console.error("Error fetching product metafields:", error);
    throw error;
  }
}

const main = async () => {
  try {
    const products = await listProducts();
    console.log(products);
    // OBTENER LOS METAFIELDS DE CADA PRODUCTO
    for (let product of products) {
      const metafields = await getProductMetafields(product.id);
      product.metafields = metafields;
    }

    // GUARDAR EL ARCHIVO EN UN JSON
    fs.writeFileSync("./test/products.json", JSON.stringify(products, null, 2));
    // Filtrar a los productos que contengan el tag "Ramos"
    const ramos = products.filter((product) => product.product_type === "Ramo");

    // GUARDAR EL ARCHIVO EN UN JSON
    fs.writeFileSync("./test/ramos.json", JSON.stringify(ramos, null, 2));
    // OBTENER LOS PRODUCTOS ASOCIADOS A LOS RAMOS
    for (let ramo of ramos) {
      // metafields en pares, producto_1, cantidad_del_producto_1, producto_2, cantidad_del_producto_2, etc
      const metafields = ramo.metafields;
      const data_productos = [];
      for (let i = 1; i <= 20; i++) {
        let producto = metafields.find(
          (metafield) => metafield.key === `producto_${i}`
        );
        const cantidad = metafields.find(
          (metafield) => metafield.key === `cantidad_del_producto_${i}`
        );
        if (producto && cantidad) {
          producto.value = producto.value.replace(/[^0-9]/g, "");

          const p = await getProduct(producto.value);

          data_productos.push({
            producto: p,
            cantidad: cantidad.value,
          });
        }
      }
      ramo.productos = data_productos;
    }

    // GUARDAR EL ARCHIVO EN UN JSON
    fs.writeFileSync(
      "./test/ramos_con_productos.json",
      JSON.stringify(ramos, null, 2)
    );
  } catch (error) {
    console.error("Error listing products:", error);
  }
};

main();
