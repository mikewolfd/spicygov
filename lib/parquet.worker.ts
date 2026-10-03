import { readPage } from "./reader";
self.onmessage = async (event) => {
  try {
    const result = await readPage(event.data, (scanned) =>
      self.postMessage({ type: "progress", scanned }),
    );
    self.postMessage({ type: "result", ...result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
