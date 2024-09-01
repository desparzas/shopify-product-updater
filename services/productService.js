const Product = require("../models/Product");

// Función para guardar un producto en MongoDB
async function saveProduct(productData) {
  try {
    const { productId } = productData;
    const id = parseInt(productId);

    const { title, productos, cantidades } = productData;
    const product = new Product({
      productId: id,
      title,
      productos,
      cantidades,
    });

    await product.save();
    // console.log("Producto guardado:", product);
    return product;
  } catch (error) {
    console.error("Error al guardar el producto:", error);
    return null;
  }
}

// Función para actualizar un producto en MongoDB
async function updateProduct(productId, updateData) {
  try {
    const id = parseInt(productId);

    const product = await Product.findOneAndUpdate(
      { productId: id },
      { $set: updateData },
      { new: true, runValidators: true }
    );
    // console.log("Producto actualizado:", product);
    return product;
  } catch (error) {
    console.error("Error al actualizar el producto:", error);
    return null;
  }
}

// Función para obtener un producto por su ID en MongoDB
async function getProductById(productId) {
  try {
    const product = await Product.findOne({ productId: productId });
    if (!product) {
      console.log("Producto no encontrado");
      return null;
    }
    return product;
  } catch (error) {
    // console.error("Error al obtener el producto:", error);
    return null;
  }
}

// Función para obtener todos los productos
async function getAllProducts() {
  try {
    const products = await Product.find();
    // console.log("Productos obtenidos:", products);

    return products;
  } catch (error) {
    console.error("Error al obtener los productos:", error);
    throw error;
  }
}

module.exports = {
  saveProduct,
  updateProduct,
  getProductById,
  getAllProducts,
};
