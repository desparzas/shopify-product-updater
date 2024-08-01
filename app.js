const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const morgan = require("morgan");
const productRoutes = require("./routes/productRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
// create express app
const app = express();

// Middleware para recibir el cuerpo raw de los webhooks
app.use(morgan("dev"));
app.use(cors());
app.use(bodyParser.raw({ type: "application/json" }));

app.use((req, res, next) => {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  next();
});

app.use("/api", productRoutes);
app.use("/webhooks", webhookRoutes);

module.exports = app;
