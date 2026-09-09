import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { startApplication } from "../src/main.js";
import { seedDemo } from "./seed-demo.js";

const config = loadConfig({
  ...process.env,
  DEMO_MODE: "true",
  NODE_ENV: "development",
  DATA_DIR: process.env.DEMO_DATA_DIR || "data/demo",
  HOST: "127.0.0.1",
});
const store = new Store(config.dbPath);
await seedDemo(store, config.dataDir);
store.close();
await startApplication(config);
