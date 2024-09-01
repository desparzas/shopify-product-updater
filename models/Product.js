const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const productSchema = new Schema(
  {
    productId: {
      type: Number,
      required: true,
      unique: true,
    },
    title: {
      type: String,
      required: true,
    },
    productos: {
      type: [Number], // IDs de productos relacionados
      required: true,
    },
    cantidades: {
      type: [Number], // Cantidades de productos relacionados
      required: true,
    },
  },
  {
    timestamps: true, // Para createdAt y updatedAt
  }
);

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
