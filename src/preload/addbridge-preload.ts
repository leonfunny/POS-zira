import { ipcRenderer } from "electron";

const ADD_ORIGIN = "https://chesaigon.eshoper.pro";
const CREATED_PRODUCT_MESSAGE = "enail:product-created";

// Runs inside the <webview> guest page. Forwards only origin-verified
// product-created messages from the embedded /add page up to the host renderer.
window.addEventListener("message", (e: MessageEvent) => {
  if (e.origin !== ADD_ORIGIN) return;
  const data: any = e.data;
  if (data?.type === CREATED_PRODUCT_MESSAGE && typeof data?.payload?.variantId === "string") {
    ipcRenderer.sendToHost(CREATED_PRODUCT_MESSAGE, data.payload);
  }
});
