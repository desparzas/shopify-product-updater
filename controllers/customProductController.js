const {
  getProductById,
  createProduct,
  searchProductByTitle,
  actualizarVarianteProducto,
} = require("../services/shopifyService");

function extractNumber(title) {
  const match = title.match(/(\d+)/); // Busca números en el título
  return match ? parseInt(match[1], 10) : null; // Devuelve el número o null si no se encuentra
}
const testProduct = async (req, res) => {
  try {
    const globosRedondos = {
      blanco: "9596621488412",
      azul: "9579162534172",
    };

    const globosNumerados = {
      azul: "9579069505820",
    };

    const body = JSON.parse(req.body.toString());

    console.log("Cuerpo de la petición:", body);

    const colorNumero = body.colorNumero;
    const primerNumero = body.primerNumero;
    const segundoNumero = body.segundoNumero;
    const coloresLatex = body.coloresLatex;

    let precioPrimerNumero = 0;
    let precioSegundoNumero = 0;

    if (globosNumerados[colorNumero]) {
      const globoNumerado = await getProductById(globosNumerados[colorNumero]);
      for (const variant of globoNumerado.variants) {
        const numero = extractNumber(variant.title);
        console.log("Número:", numero);
        if (numero == primerNumero) {
          console.log("Encontré la variante del primer número");
          precioPrimerNumero = variant.price;
        }
        if (numero == segundoNumero) {
          console.log("Encontré la variante del segundo número");
          precioSegundoNumero = variant.price;
        }
      }
    } else {
      console.log("No se encontró el producto de número");
    }

    let preciosGlobosLatex = {};

    for (const color of coloresLatex) {
      console.log("Color de globo de látex:", color);
      const globoRedondo = await getProductById(globosRedondos[color]);
      if (globoRedondo) {
        preciosGlobosLatex[color] = globoRedondo.variants[0].price;
      } else {
        preciosGlobosLatex[color] = 0;
      }
    }

    if (precioPrimerNumero == 0 || precioSegundoNumero == 0) {
      console.log("No se encontraron los precios de los números");
      throw new Error("No se encontraron los precios de los números");
    }

    for (const color of coloresLatex) {
      if (preciosGlobosLatex[color] == 0) {
        console.log("No se encontró el precio de un globo de látex");
        throw new Error("No se encontró el precio de un globo de látex");
      }
    }

    // calcular precio total

    let precioTotal =
      parseFloat(precioPrimerNumero) + parseFloat(precioSegundoNumero);

    for (const color of coloresLatex) {
      precioTotal += parseFloat(preciosGlobosLatex[color]);
    }

    // crear un nuevo producto, el title es el color del globo
    const colores_globo = coloresLatex.join(", ");
    const title = `Ramo número ${primerNumero}${segundoNumero} ${colorNumero} con globos de látex color ${colores_globo}`;
    const productData = {
      title,
      price: precioTotal,
    };
    const existingProductList = await searchProductByTitle(title);

    let existingProduct = null;
    if (existingProductList.length > 0) {
      existingProduct = existingProductList[0];
    }

    let newProduct = null;

    if (existingProduct) {
      const variant = existingProduct.variants[0];

      console.log("El producto ya existe");
      await actualizarVarianteProducto(
        existingProduct.id,
        variant.id,
        precioTotal
      );
    } else {
      console.log("El producto no existe");
      newProduct = await createProduct(productData);
    }

    console.log("Título:", title);
    console.log("Precio total:", precioTotal);
    console.log(
      "ID del producto:",
      newProduct ? newProduct.id : existingProduct.id
    );

    // obtener el id de la variante del producto

    const idVariante = newProduct
      ? newProduct.variants[0].id
      : existingProduct.variants[0].id;
    data = {};
    res.json({
      precioTotal,
      title,
      id: newProduct ? newProduct.id : existingProduct.id,
      idVariante,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  testProduct,
};
