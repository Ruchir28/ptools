import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

type CsvRow = Readonly<Record<string, string>>;

type CsvColumnProfile = {
  readonly name: string;
  readonly kind: "number" | "date" | "string" | "empty";
  readonly nonEmptyCount: number;
  readonly distinctCount: number;
  readonly sampleValues: ReadonlyArray<string>;
};

const csvPath = resolve(process.argv[2] ?? "data/demo-sales.csv");

const server = new McpServer({
  name: "ptools-csv-dataset",
  version: "0.0.0",
});

server.registerTool(
  "inspect_csv_dataset",
  {
    title: "Inspect CSV dataset",
    description:
      "Read dataset metadata before deciding which columns or rows to request.",
    inputSchema: {
      sampleSize: z.number().int().min(1).max(10).optional(),
    },
    outputSchema: {
      csvPath: z.string(),
      rowCount: z.number(),
      columns: z.array(
        z.object({
          name: z.string(),
          kind: z.enum(["number", "date", "string", "empty"]),
          nonEmptyCount: z.number(),
          distinctCount: z.number(),
          sampleValues: z.array(z.string()),
        }),
      ),
      sampleRows: z.array(z.record(z.string(), z.string())),
    },
  },
  async ({ sampleSize = 3 }) => {
    const dataset = await loadCsvDataset();
    const profile = {
      csvPath,
      rowCount: dataset.rows.length,
      columns: profileColumns(dataset.headers, dataset.rows),
      sampleRows: dataset.rows.slice(0, sampleSize),
    };

    return asJsonToolResult(profile);
  },
);

server.registerTool(
  "read_csv_rows",
  {
    title: "Read CSV rows",
    description:
      "Read selected dataset rows after inspecting metadata and choosing relevant columns.",
    inputSchema: {
      columns: z.array(z.string().trim().min(1)).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    outputSchema: {
      csvPath: z.string(),
      rowCount: z.number(),
      returnedRowCount: z.number(),
      columns: z.array(z.string()),
      rows: z.array(z.record(z.string(), z.string())),
    },
  },
  async ({ columns, limit = 25, offset = 0 }) => {
    const dataset = await loadCsvDataset();
    const selectedColumns = columns ?? dataset.headers;

    assertKnownColumns(dataset.headers, selectedColumns);

    const rows = dataset.rows
      .slice(offset, offset + limit)
      .map((row) => selectColumns(row, selectedColumns));
    const result = {
      csvPath,
      rowCount: dataset.rows.length,
      returnedRowCount: rows.length,
      columns: selectedColumns,
      rows,
    };

    return asJsonToolResult(result);
  },
);

server.registerTool(
  "summarize_csv_column",
  {
    title: "Summarize CSV column",
    description:
      "Summarize one discovered column by name after inspecting dataset metadata.",
    inputSchema: {
      column: z.string().trim().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: {
      csvPath: z.string(),
      column: z.string(),
      profile: z.object({
        name: z.string(),
        kind: z.enum(["number", "date", "string", "empty"]),
        nonEmptyCount: z.number(),
        distinctCount: z.number(),
        sampleValues: z.array(z.string()),
      }),
      values: z.array(
        z.object({
          value: z.string(),
          count: z.number(),
        }),
      ),
      numeric: z
        .object({
          min: z.number(),
          max: z.number(),
          sum: z.number(),
          average: z.number(),
        })
        .optional(),
    },
  },
  async ({ column, limit = 20 }) => {
    const dataset = await loadCsvDataset();

    assertKnownColumns(dataset.headers, [column]);

    const profile = profileColumn(column, dataset.rows);
    const values = [...countValues(dataset.rows, column).entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, limit);
    const result = {
      csvPath,
      column,
      profile,
      values,
      ...(profile.kind === "number"
        ? { numeric: summarizeNumericColumn(dataset.rows, column) }
        : {}),
    };

    return asJsonToolResult(result);
  },
);

server.registerTool(
  "group_csv_rows",
  {
    title: "Group CSV rows",
    description:
      "Group rows by one discovered column and optionally summarize one discovered numeric column.",
    inputSchema: {
      groupByColumn: z.string().trim().min(1),
      valueColumn: z.string().trim().min(1).optional(),
      sortBy: z.enum(["rowCount", "sum", "average", "min", "max"]).optional(),
      sortDirection: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: {
      csvPath: z.string(),
      groupByColumn: z.string(),
      valueColumn: z.string().optional(),
      groups: z.array(
        z.object({
          key: z.string(),
          rowCount: z.number(),
          sum: z.number().optional(),
          average: z.number().optional(),
          min: z.number().optional(),
          max: z.number().optional(),
        }),
      ),
    },
  },
  async ({
    groupByColumn,
    valueColumn,
    sortBy = valueColumn === undefined ? "rowCount" : "sum",
    sortDirection = "desc",
    limit = 20,
  }) => {
    const dataset = await loadCsvDataset();

    assertKnownColumns(
      dataset.headers,
      valueColumn === undefined ? [groupByColumn] : [groupByColumn, valueColumn],
    );

    const direction = sortDirection === "asc" ? 1 : -1;
    const groups = [...groupRows(dataset.rows, groupByColumn).entries()]
      .map(([key, rows]) => ({
        key,
        rowCount: rows.length,
        ...(valueColumn === undefined
          ? {}
          : summarizeNumericRows(rows, valueColumn)),
      }))
      .sort((left, right) => {
        const leftValue = left[sortBy] ?? 0;
        const rightValue = right[sortBy] ?? 0;

        return direction * (leftValue - rightValue);
      })
      .slice(0, limit);
    const result = {
      csvPath,
      groupByColumn,
      ...(valueColumn === undefined ? {} : { valueColumn }),
      groups,
    };

    return asJsonToolResult(result);
  },
);

await server.connect(new StdioServerTransport());

const loadCsvDataset = async (): Promise<{
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<CsvRow>;
}> => {
  const csv = await readFile(csvPath, "utf8");
  const [headerLine, ...dataLines] = csv.trim().split(/\r?\n/);

  if (headerLine === undefined) {
    throw new Error(`CSV is empty: ${csvPath}`);
  }

  const headers = parseCsvLine(headerLine);
  const rows = dataLines.map((line) => {
    const values = parseCsvLine(line);

    return Object.fromEntries(
      headers.map((header, headerIndex) => [header, values[headerIndex] ?? ""]),
    );
  });

  return { headers, rows };
};

const profileColumns = (
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<CsvRow>,
): ReadonlyArray<CsvColumnProfile> =>
  headers.map((header) => profileColumn(header, rows));

const profileColumn = (
  column: string,
  rows: ReadonlyArray<CsvRow>,
): CsvColumnProfile => {
  const values = rows
    .map((row) => row[column] ?? "")
    .filter((value) => value.trim().length > 0);
  const distinctValues = [...new Set(values)];

  return {
    name: column,
    kind: inferColumnKind(values),
    nonEmptyCount: values.length,
    distinctCount: distinctValues.length,
    sampleValues: distinctValues.slice(0, 5),
  };
};

const inferColumnKind = (
  values: ReadonlyArray<string>,
): CsvColumnProfile["kind"] => {
  if (values.length === 0) {
    return "empty";
  }

  if (values.every((value) => Number.isFinite(Number(value)))) {
    return "number";
  }

  if (values.every((value) => !Number.isNaN(Date.parse(value)))) {
    return "date";
  }

  return "string";
};

const countValues = (
  rows: ReadonlyArray<CsvRow>,
  column: string,
): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const value = row[column] ?? "";

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return counts;
};

const summarizeNumericColumn = (
  rows: ReadonlyArray<CsvRow>,
  column: string,
): {
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly average: number;
} => summarizeNumericRows(rows, column);

const summarizeNumericRows = (
  rows: ReadonlyArray<CsvRow>,
  column: string,
): {
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly average: number;
} => {
  const values = rows.map((row) => Number(row[column])).filter(Number.isFinite);
  const sum = values.reduce((total, value) => total + value, 0);

  return {
    min: values.length === 0 ? 0 : Math.min(...values),
    max: values.length === 0 ? 0 : Math.max(...values),
    sum: roundNumber(sum),
    average: values.length === 0 ? 0 : roundNumber(sum / values.length),
  };
};

const groupRows = (
  rows: ReadonlyArray<CsvRow>,
  groupByColumn: string,
): ReadonlyMap<string, ReadonlyArray<CsvRow>> => {
  const groups = new Map<string, Array<CsvRow>>();

  for (const row of rows) {
    const key = row[groupByColumn] ?? "";
    const group = groups.get(key);

    if (group === undefined) {
      groups.set(key, [row]);
    } else {
      group.push(row);
    }
  }

  return groups;
};

const selectColumns = (
  row: CsvRow,
  columns: ReadonlyArray<string>,
): Record<string, string> =>
  Object.fromEntries(columns.map((column) => [column, row[column] ?? ""]));

const assertKnownColumns = (
  headers: ReadonlyArray<string>,
  columns: ReadonlyArray<string>,
): void => {
  const unknown = columns.filter((column) => !headers.includes(column));

  if (unknown.length > 0) {
    throw new Error(`Unknown CSV column(s): ${unknown.join(", ")}`);
  }
};

const asJsonToolResult = <T extends Record<string, unknown>>(value: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const parseCsvLine = (line: string): ReadonlyArray<string> => {
  const cells: Array<string> = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);

  return cells;
};

const roundNumber = (value: number): number => Math.round(value * 100) / 100;
