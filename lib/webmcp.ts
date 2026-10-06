"use client";
import { validFilter } from './filter-values';
import { useEffect, useRef } from "react";
import type { Dataset, Filter, Row } from "./catalog";
import { recordDatasets } from './catalog';
import type { RecordSort } from './record-sort';
type State = {
  id: string;
  filters: Filter[];
  busy: boolean;
  error: string;
  rows: Row[];
  columns: string[];
  sort?: RecordSort;
};
type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => unknown;
};
type Context = {
  registerTool: (
    tool: Tool,
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function useExplorerTools(
  catalog: Dataset[],
  state: State,
  open: (id: string, filters: Filter[]) => void,
) {
  const current = useRef(state),
    action = useRef(open);
  current.current = state;
  action.current = open;
  useEffect(() => {
    const context = (document as Document & { modelContext?: Context })
      .modelContext;
    if (!context?.registerTool || !catalog.length) return;
    const lifecycle = new AbortController();
    const read = () =>
      JSON.parse(
        JSON.stringify(
          {
            ...current.current,
            rows: current.current.rows.slice(0, 5),
            datasets: recordDatasets(catalog).map((t) => ({
              id: t.id,
              label: t.label,
              rows: t.rows,
            })),
          },
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      );
    const tools: Tool[] = [
      {
        name: "read_explorer",
        description:
          "Read the visible dataset, filters, sort order, loading state, first five visible records, and available datasets.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: read,
      },
      {
        name: "open_dataset",
        description:
          "Open a published dataset with optional exact-value filters in the explorer. Returns when records finish loading or a loading status after 20 seconds.",
        inputSchema: {
          type: "object",
          properties: {
            table: { type: "string" },
            filters: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  column: { type: "string" },
                  value: { type: "string" },
                  values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
                },
                required: ["column", "value"],
                additionalProperties: false,
              },
            },
          },
          required: ["table"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input) => {
          if (!input || typeof input !== "object")
            throw new Error("Expected a table and optional filters.");
          const { table, filters = [] } = input as {
            table: unknown;
            filters: unknown;
          };
          const dataset = catalog.find((t) => t.id === table);
          if (!dataset) throw new Error("Unknown published dataset.");
          if (
            !Array.isArray(filters) ||
            !filters.every(
              (f) =>
                f &&
                validFilter(f) &&
                dataset.columns.some((c) => c.name === f.column),
            )
          )
            throw new Error(
              "Filters must name existing fields and use string values.",
            );
          action.current(dataset.id, filters);
          for (let i = 0; i < 100; i++) {
            await new Promise((r) => setTimeout(r, 200));
            const s = current.current;
            if (
              s.id === dataset.id &&
              JSON.stringify(s.filters) === JSON.stringify(filters) &&
              !s.busy
            )
              return read();
          }
          return { status: "loading", table: dataset.id };
        },
      },
    ];
    for (const tool of tools) {
      try {
        void Promise.resolve(
          context.registerTool(tool, { signal: lifecycle.signal }),
        ).catch(() => {});
      } catch {}
    }
    return () => lifecycle.abort();
  }, [catalog]);
}
