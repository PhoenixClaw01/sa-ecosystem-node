import { bindPage } from "./playground.js";

if (globalThis.document && globalThis.document.getElementById("pg-tools")) {
  bindPage(globalThis.document).catch(() => {});
}
