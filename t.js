async function actualizarRamosSimplesDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return;
    }
    const precioNuevo = parseFloat(product.variants[0].price);
    const ramos = await obtenerBundlesContienenProducto(id, "Ramo Simple");
    const ramosSimples = ramos.filter((ramo) => {
      return (
        ramo.productos.every(
          (producto) => producto.producto.variants.length === 1
        ) && ramo.variants.length === 1
      );
    });

    const actualizaciones = ramosSimples.map(async (ramo) => {
      let precioRamo = 0;
      ramo.productos.forEach((producto) => {
        const precioProducto = parseFloat(producto.producto.variants[0].price);
        const cantidad = producto.cantidad;
        precioRamo +=
          (producto.producto.id !== id ? precioProducto : precioNuevo) *
          cantidad;
      });
      const precioRamoNuevo = precioRamo.toFixed(2);
      if (precioRamoNuevo !== ramo.variants[0].price) {
        console.log(
          `Actualizado el precio del ramo ${ramo.title} a ${precioRamoNuevo} de ${ramo.variants[0].price} a ${precioRamoNuevo}`
        );

        await shopify.productVariant.update(ramo.variants[0].id, {
          price: precioRamoNuevo,
        });
      }
    });

    await Promise.all(actualizaciones);

    console.log("Ramos simples actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando ramos simples: ", error);
  }
}

async function actualizarGlobosNumeradosDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return;
    }
    const globosNumerados = await obtenerBundlesContienenProducto(
      id,
      "Globo de Número"
    );

    const actualizaciones = globosNumerados.map(async (globo) => {
      let variantsTemp = JSON.parse(JSON.stringify(globo.variants));
      const posibleOptions = [];
      for (let variant of variantsTemp) {
        const option1 = variant.option1;
        if (!posibleOptions.includes(option1)) {
          const formatted = option1.replace("Globo N°", "");
          posibleOptions.push(formatted);
        }
      }

      const productoGlobo = globo.productos.find(
        (producto) => producto.producto.product_type === "Globo de Número"
      );

      const simples = globo.productos.filter(
        (producto) => producto.producto.variants.length === 1
      );
      let sumaSimples = 0;
      for (let simple of simples) {
        sumaSimples +=
          parseFloat(simple.producto.variants[0].price) * simple.cantidad;
      }

      let variantsUpdated = false;
      for (let i of posibleOptions) {
        const variantTemp = variantsTemp.find(
          (variant) => variant.option1 === `Globo N°${i}`
        );
        const index = variantsTemp.indexOf(variantTemp);
        const variant = globo.variants.find(
          (variant) => variant.option1 === `Globo N°${i}`
        );

        const unitVariant = productoGlobo.producto.variants.find(
          (variant) => variant.option1 === `Globo N°${i}`
        );

        if (variant.price !== sumaSimples + parseFloat(unitVariant.price)) {
          const precioNuevo = sumaSimples + parseFloat(unitVariant.price);
          const precioNuevoString = precioNuevo.toFixed(2);
          variantsTemp[index].price = precioNuevoString;
          variantsUpdated = true;
        }
      }

      if (variantsUpdated) {
        await shopify.product.update(globo.id, { variants: variantsTemp });
      }
    });

    await Promise.all(actualizaciones);

    console.log("Globos numerados actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando globos numerados: ", error);
  }
}

async function actualizarRamosDoblesNumeradosDeProducto(productId) {
  try {
    const id = parseInt(productId, 10);
    const product = await getProductById(id);
    if (!product) {
      console.log(
        "Producto no encontrado en la base de datos desde la función updateRamosSimples"
      );
      return;
    }
    const ramosDoblesNumerados = await obtenerBundlesContienenProducto(
      id,
      "Ramo Doble Numerado"
    );

    const actualizaciones = ramosDoblesNumerados.map(async (globo) => {
      let variantsTemp = JSON.parse(JSON.stringify(globo.variants));
      const posibleOptions = [];

      for (let variant of variantsTemp) {
        const option1 = variant.option1;
        const option2 = variant.option2;
        const combinedOptions = `${option1}-${option2}`;
        if (!posibleOptions.includes(combinedOptions)) {
          const formattedOption1 = option1.replace("Globo N°", "");
          const formattedOption2 = option2.replace("Globo N°", "");
          posibleOptions.push({
            option1: formattedOption1,
            option2: formattedOption2,
          });
        }
      }

      const productoGlobo = globo.productos.find(
        (producto) => producto.producto.product_type === "Globo de Número"
      );

      const simples = globo.productos.filter(
        (producto) => producto.producto.variants.length === 1
      );
      let sumaSimples = 0;
      for (let simple of simples) {
        sumaSimples +=
          parseFloat(simple.producto.variants[0].price) * simple.cantidad;
      }

      let variantsUpdated = false;
      for (let options of posibleOptions) {
        const { option1, option2 } = options;
        const variantTemp = variantsTemp.find(
          (variant) =>
            variant.option1 === `Globo N°${option1}` &&
            variant.option2 === `Globo N°${option2}`
        );
        const index = variantsTemp.indexOf(variantTemp);
        const variant = globo.variants.find(
          (variant) =>
            variant.option1 === `Globo N°${option1}` &&
            variant.option2 === `Globo N°${option2}`
        );

        const unitVariant1 = productoGlobo.producto.variants.find(
          (variant) => variant.option1 === `Globo N°${option1}`
        );
        const unitVariant2 = productoGlobo.producto.variants.find(
          (variant) => variant.option1 === `Globo N°${option2}`
        );

        const nuevoPrecio =
          sumaSimples +
          parseFloat(unitVariant1.price) +
          parseFloat(unitVariant2.price);

        const nuevoPrecioString = nuevoPrecio.toFixed(2);

        if (variant.price !== nuevoPrecioString) {
          variantsTemp[index].price = nuevoPrecioString;
          variantsUpdated = true;
        }
      }
      if (variantsUpdated) {
        await shopify.product.update(globo.id, { variants: variantsTemp });
      }
    });

    await Promise.all(actualizaciones);

    console.log("Globos numerados actualizados del producto ", product.title);
  } catch (error) {
    console.log("Error actualizando globos numerados: ", error);
  }
}
