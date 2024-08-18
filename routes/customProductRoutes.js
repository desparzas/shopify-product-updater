const express = require("express");
const { testProduct } = require("../controllers/customProductController.js");

const router = express.Router();

router.post("/test", testProduct);
module.exports = router;
