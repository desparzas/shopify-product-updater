const {
  listProducts,
  getProductById,
  getProductCustomMetafields,
  getProductByProductType,
} = require("../services/shopifyService");

const getProducts = async (req, res) => {
  try {
    console.log("Fetching products...");
    const products = await listProducts();
    res.json({
      data: products,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getProduct = async (req, res) => {
  try {
    console.log("Fetching product...");
    const { id } = req.params;
    const product = await getProductById(id);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    product.metafields = await getProductCustomMetafields(id);
    res.json({
      data: product,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getRamos = async (req, res) => {
  try {
    const products = await getProductByProductType("Ramo");
    res.json({
      data: products,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  getProducts,
  getProduct,
  getRamos,
};
