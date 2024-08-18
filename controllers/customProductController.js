const testProduct = async (req, res) => {
  try {
    // IMPRIMIR EL CUERPO DE LA PETICIÓN
    // parsear el cuerpo de la petición
    const body = JSON.parse(req.body.toString());

    console.log("Cuerpo de la petición:", body);

    const colorNumero = body.colorNumero;
    const primerNumero = body.primerNumero;
    const segundoNumero = body.segundoNumero;
    const coloresLatex = body.coloresLatex;

    data = {};
    res.json({
      colorNumero,
      primerNumero,
      segundoNumero,
      coloresLatex,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  testProduct,
};
