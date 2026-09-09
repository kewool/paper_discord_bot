import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { startApplication } from "../src/main.js";
import { seedDemo } from "./seed-demo.js";
import { seedDemoTranslation } from "./seed-demo-translation.js";

const config = loadConfig({
  ...process.env,
  DEMO_MODE: "true",
  TRANSLATION_ENABLED: "true",
  NODE_ENV: "development",
  DATA_DIR: process.env.DEMO_DATA_DIR || "data/demo",
  HOST: "127.0.0.1",
});
const store = new Store(config.dbPath);
await seedDemo(store, config.dataDir);
await seedDemoTranslation(store);
store.close();
await startApplication(config);
