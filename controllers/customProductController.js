const {
  getProductById,
  createCustomProductTest,
  searchProductByTitle,
  actualizarVarianteProducto,
  searchProductByDataExtra,
  addDataExtraToProduct,
} = require("../services/shopifyService");

const { globosNumerados, globosLatex } = require("../utils/products");
const { extractNumber } = require("../utils/functions");

const TOTAL_GLOBOS_LATEX = 12;

const testProduct = async (req, res) => {
  try {
    const body = JSON.parse(req.body.toString());

    console.log("Cuerpo de la petición:", body);

    const colorNumero = body.colorNumero;
    const primerNumero = parseInt(body.primerNumero);
    const segundoNumero = parseInt(body.segundoNumero);
    const coloresLatex = body.coloresLatex;

    let precioPrimerNumero;
    let idVariantPrimerNumero;
    let precioSegundoNumero;
    let idVariantSegundoNumero;

    let dataPrimerNumero;
    let dataSegundoNumero;

    console.log(globosNumerados);

    if (globosNumerados[colorNumero]) {
      const globoNumerado = await getProductById(globosNumerados[colorNumero]);
      for (const variant of globoNumerado.variants) {
        const numero = parseInt(extractNumber(variant.title));
        if (numero === primerNumero) {
          idVariantPrimerNumero = variant.id;
          precioPrimerNumero = variant.price;
        }
        if (numero === segundoNumero) {
          idVariantSegundoNumero = variant.id;
          precioSegundoNumero = variant.price;
        }
      }
    } else {
      throw new Error("No se encontró el producto de número");
    }

    if (!precioPrimerNumero || !precioSegundoNumero) {
      throw new Error("No se encontraron los precios de los números");
    }
    console.log("Precio del primer número:", precioPrimerNumero);
    console.log("Precio del segundo número:", precioSegundoNumero);

    console.log("_".repeat(50));

    let dataGlobosLatex = {};

    for (const color of coloresLatex) {
      console.log("Color:", color);
      const globoLatex = await getProductById(globosLatex[color]);
      if (globoLatex) {
        dataGlobosLatex[color] = {
          id: globoLatex.variants[0].id,
          price: globoLatex.variants[0].price,
          cantidad: TOTAL_GLOBOS_LATEX / coloresLatex.length,
        };
      } else {
        throw new Error("No se encontró el precio de un globo de látex");
      }
    }

    let precioTotal =
      parseFloat(precioPrimerNumero) + parseFloat(precioSegundoNumero);

    for (const color of coloresLatex) {
      precioTotal +=
        parseFloat(dataGlobosLatex[color].price) *
        parseFloat(dataGlobosLatex[color].cantidad);
    }

    console.log("Precios de los globos de látex:", dataGlobosLatex);

    console.log("Precio total:", precioTotal);

    const colores_globo = coloresLatex.join(", ");
    const title = `Ramo número ${primerNumero}${segundoNumero} ${colorNumero} con globos de látex color ${colores_globo}`;

    const productData = {
      title,
      price: precioTotal,
    };

    const dataExtra = {
      idVariantPrimerNumero,
      idVariantSegundoNumero,
      precioPrimerNumero,
      precioSegundoNumero,
      dataGlobosLatex,
      colorNumero,
    };

    const existingProductList = await searchProductByTitle(title);

    let existingProduct;
    if (existingProductList.length > 0) {
      existingProduct = existingProductList[0];
    }

    let newProduct;

    if (existingProduct) {
      const variant = existingProduct.variants[0];
      console.log("El producto ya existe");
      await actualizarVarianteProducto(
        existingProduct.id,
        variant.id,
        precioTotal
      );
      await addDataExtraToProduct(existingProduct.id, dataExtra);
    } else {
      console.log("El producto no existe");
      newProduct = await createCustomProductTest(productData);
      await addDataExtraToProduct(newProduct.id, dataExtra);
    }

    console.log("Datos del producto:", productData);
    console.log("Datos extra:", dataExtra);

    console.log(
      "ID del producto:",
      newProduct ? newProduct.id : existingProduct.id
    );

    const idVariante = newProduct
      ? newProduct.variants[0].id
      : existingProduct.variants[0].id;
    const data = {
      precioTotal,
      title,
      id: newProduct ? newProduct.id : existingProduct.id,
      idVariante,
    };
    res.status(200).json(data);
  } catch (error) {
    console.log("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  testProduct,
};
