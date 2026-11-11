import { decodeCatalogFileShard } from './catalog-parquet';
import { readPage } from "./reader";
import {locateRecord} from './record-lookup';
self.onmessage = async (event) => {
  try {
    if (event.data.type === 'catalog-files') {
      const page = await decodeCatalogFileShard(event.data.buffer,event.data.context);
      self.postMessage({type:'catalog-files',page}); return;
    }
    if(event.data.type==='lookup') {
      const result=await locateRecord(event.data.table,event.data.filters,event.data.cursor,event.data.positions,(scanned)=>self.postMessage({type:'progress',scanned}));
      self.postMessage({type:'lookup',...result});return;
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
