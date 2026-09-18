import app from "./src/app";
import { env } from "./src/config/env";

app.listen(env.PORT, "0.0.0.0", () => {
  console.log(`API listening on port ${env.PORT}`);
});