const shopifyService = require("./services/shopifyService");
const fs = require("fs");
const main = async () => {
  try {
    const productos = await shopifyService.listProducts();
    fs.writeFileSync(
      "./test/products.json",
      JSON.stringify(productos, null, 2)
    );

    const idMano = 9524883128604;
    const idGlobo = 9558115942684;
    const idGloboBase = 9541210472732;
    const id2 = 9517462487324;

    const bundles = await shopifyService.obtenerBundlesContienenProducto(
      idGloboBase
    );

    fs.writeFileSync(
      "./test/bundlestest.json",
      JSON.stringify(bundles, null, 2)
    );
    await shopifyService.procesarProducto(idGloboBase);
  } catch (error) {
    console.error("Error fetching products:", error);
  }
};

main();
