const fs = require("fs");
const path = require("path");
const shopifyService = require("./services/shopifyService");

// Ruta del archivo JSON
async function main() {
  // leer el archivo productoActualizartest.json
  const filePath = path.join(__dirname, "test", "productoActualizartest.json");
  const file = fs.readFileSync(filePath, "utf8");

  // Convertir el archivo a un objeto
  const product = JSON.parse(file);

  // console.log(product);

  // const id = 9600280920348;

  // const c = await shopifyService.productCount();
  // console.log(c);

  // const allProducts = await shopifyService.listProducts();

  await shopifyService.actualizarBundlesDeProducto(product);

  // for (const p of allProducts) {
  //   console.log(p.title);
  // }
}

main();
