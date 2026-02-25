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
      required: false,
    },
    productos: {
      type: [Number], // IDs de productos relacionados
      required: true,
    },
    cantidades: {
      type: [Number], // Cantidades de productos relacionados
      required: true,
    },
    productosVinculados: {
      type: [Number], // IDs de productos referenciados en opciones_vinculadas
      default: [],
    },
  },
  {
    timestamps: true, // Para createdAt y updatedAt
  }
);

const Product = mongoose.model("Product", productSchema);
module.exports = Product;
