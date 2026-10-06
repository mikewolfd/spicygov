import { receiptFields, readSourceEvidence } from "./receipt-reader";
import { readPage } from "./reader";
self.onmessage = async (event) => {
  try {
    if (event.data.type === "source-evidence") {
      const result = await readSourceEvidence(event.data.table,event.data.dataset,event.data.filters,(scanned)=>self.postMessage({type:"progress",scanned}),event.data.cursor);
      self.postMessage({type:"source-evidence",...result,dataset:event.data.dataset,filters:event.data.filters}); return;
    }
    if (event.data.type === "receipt") {
      const fields = await receiptFields(event.data.table,event.data.row,event.data.fields,(scanned)=>self.postMessage({type:"progress",scanned}));
      self.postMessage({type:"receipt",fields}); return;
    }
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
