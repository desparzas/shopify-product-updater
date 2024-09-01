async function updateBundleTest(bundleId) {
  try {
    // await loadCache();
    const { validBundle, error, optionsOut, variantsOut } = await updateBundle(
      bundleId
    );

    const updatePromises = [];

    if (validBundle) {
      const bundle = await getProductById(bundleId);
      const { options, variants } = bundle;
      console.log("El bundle es válido");
      let updateOptions = false;
      let updateVariants = false;

      if (options.length !== optionsOut.length) {
        updateOptions = true;
      }

      if (variants.length !== variantsOut.length) {
        updateVariants = true;
      }

      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const optionOut = optionsOut[i];

        if (
          option.name !== optionOut.name ||
          option.values.length !== optionOut.values.length
        ) {
          updateOptions = true;
          break;
        }

        const { values } = option;
        const { values: valuesOut } = optionOut;

        for (let j = 0; j < values.length; j++) {
          const { value } = values[j];
          const { value: valueOut } = valuesOut[j];

          if (value !== valueOut) {
            updateOptions = true;
            break;
          }
        }
      }

      // para los variants validar que su option1, option2, option3, y price sean iguales

      for (let i = 0; i < variants.length; i++) {
        const variant = variants[i];
        const variantOut = variantsOut[i];
        const { option1, option2, option3, price } = variant;
        const {
          option1: option1Out,
          option2: option2Out,
          option3: option3Out,
          price: priceOut,
        } = variantOut;

        if (
          option1 !== option1Out ||
          option2 !== option2Out ||
          option3 !== option3Out ||
          parseFloat(price) !== parseFloat(priceOut)
        ) {
          updateVariants = true;
          break;
        }
      }

      if (updateOptions || updateVariants) {
        console.log("Hay cambios en las opciones o en las variantes");
        updatePromises.push(() =>
          shopify.product.update(bundleId, {
            options: optionsOut,
            variants: variantsOut,
          })
        );
      } else {
        console.log("No hay cambios en las opciones ni en las variantes");
      }
    } else {
      const optionDefault = [
        {
          name: "Title",
          values: ["Default Title"],
        },
      ];

      const variantDefault = [
        {
          option1: "Default Title",
          price: precioTotal,
          title: "Default Title",
        },
      ];

      console.log("El bundle no es válido");

      updatePromises.push(() =>
        shopify.product.update(bundleId, {
          options: optionDefault,
          variants: variantDefault,
        })
      );
      console.log("Error:", error);
    }

    await processPromisesBatch(updatePromises);

    const updatePromises2 = [];
    const bundles = getBundlesDBWithProduct(bundleId);

    for (const [id, bundle] of bundles.entries()) {
      updatePromises2.push(() => updateBundleTest(id));
    }

    await processPromisesBatch(updatePromises2);

    // ejecutar las promesas de actualización

    //console.log("Bundles con el producto:", bundles.size);
  } catch (error) {
    console.log("Error actualizando el bundle:", error);
  }
}
