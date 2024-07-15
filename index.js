const app = require("./app");
const config = require("./utils/config");
const { PORT } = config;
const { listProducts } = require("./services/shopifyService");

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
