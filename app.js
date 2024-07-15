const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const productRoutes = require("./routes/productRoutes");
const webhookRoutes = require("./routes/webhookRoutes");
// create express app
const app = express();

// Middleware para recibir el cuerpo raw de los webhooks
app.use(cors());
app.use(bodyParser.raw({ type: "application/json" }));

app.use("/api", productRoutes);
app.use("/webhooks", webhookRoutes);

module.exports = app;
