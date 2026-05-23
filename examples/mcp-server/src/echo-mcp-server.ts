import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "ptools-example-order-desk",
  version: "0.0.0",
});

const products = [
  {
    sku: "TEA-ASSAM-250",
    name: "Assam Breakfast Tea 250g",
    category: "tea",
    unitPrice: 12.5,
    stock: 42,
  },
  {
    sku: "COF-ARAB-500",
    name: "Arabica Coffee 500g",
    category: "coffee",
    unitPrice: 18,
    stock: 18,
  },
  {
    sku: "BIS-CARD-120",
    name: "Cardamom Biscuits 120g",
    category: "snacks",
    unitPrice: 6.75,
    stock: 7,
  },
  {
    sku: "HON-WILD-350",
    name: "Wildflower Honey 350g",
    category: "pantry",
    unitPrice: 14.25,
    stock: 0,
  },
] as const;

const customers = {
  "cust-001": {
    customerId: "cust-001",
    name: "Nila Grocery",
    tier: "wholesale",
    discountPercent: 12,
  },
  "cust-002": {
    customerId: "cust-002",
    name: "Studio Pantry",
    tier: "retail",
    discountPercent: 0,
  },
} as const;

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo text back to the caller.",
    inputSchema: {
      text: z.string(),
    },
    outputSchema: {
      text: z.string(),
    },
  },
  async ({ text }) => ({
    content: [{ type: "text", text }],
    structuredContent: { text },
  }),
);

server.registerTool(
  "add",
  {
    title: "Add",
    description: "Add two numbers.",
    inputSchema: {
      a: z.number(),
      b: z.number(),
    },
    outputSchema: {
      sum: z.number(),
    },
  },
  async ({ a, b }) => {
    const sum = a + b;

    return {
      content: [{ type: "text", text: String(sum) }],
      structuredContent: { sum },
    };
  },
);

server.registerTool(
  "list_products",
  {
    title: "List products",
    description:
      "List sellable products with SKU, category, unit price, and available stock.",
    inputSchema: {
      category: z.enum(["tea", "coffee", "snacks", "pantry"]).optional(),
      inStockOnly: z.boolean().optional(),
    },
    outputSchema: {
      products: z.array(
        z.object({
          sku: z.string(),
          name: z.string(),
          category: z.string(),
          unitPrice: z.number(),
          stock: z.number(),
        }),
      ),
    },
  },
  async ({ category, inStockOnly = false }) => {
    const filtered = products.filter(
      (product) =>
        (category === undefined || product.category === category) &&
        (!inStockOnly || product.stock > 0),
    );

    return asJsonToolResult({ products: filtered });
  },
);

server.registerTool(
  "get_customer_terms",
  {
    title: "Get customer terms",
    description:
      "Look up customer pricing terms before creating a quote or order.",
    inputSchema: {
      customerId: z.string(),
    },
    outputSchema: {
      customerId: z.string(),
      name: z.string(),
      tier: z.string(),
      discountPercent: z.number(),
    },
  },
  async ({ customerId }) => {
    const customer = customers[customerId as keyof typeof customers];

    if (customer === undefined) {
      throw new Error(`Unknown customer: ${customerId}`);
    }

    return asJsonToolResult(customer);
  },
);

server.registerTool(
  "check_inventory",
  {
    title: "Check inventory",
    description:
      "Check whether requested line items can be fulfilled from current stock.",
    inputSchema: {
      items: z.array(
        z.object({
          sku: z.string(),
          quantity: z.number().int().positive(),
        }),
      ),
    },
    outputSchema: {
      checks: z.array(
        z.object({
          sku: z.string(),
          requested: z.number(),
          available: z.number(),
          canFulfill: z.boolean(),
        }),
      ),
      allAvailable: z.boolean(),
    },
  },
  async ({ items }) => {
    const checks = items.map(({ sku, quantity }) => {
      const product = findProduct(sku);

      return {
        sku,
        requested: quantity,
        available: product.stock,
        canFulfill: product.stock >= quantity,
      };
    });

    return asJsonToolResult({
      checks,
      allAvailable: checks.every((item) => item.canFulfill),
    });
  },
);

server.registerTool(
  "create_quote",
  {
    title: "Create quote",
    description:
      "Create a priced quote from customer terms and requested line items.",
    inputSchema: {
      customerId: z.string(),
      items: z.array(
        z.object({
          sku: z.string(),
          quantity: z.number().int().positive(),
        }),
      ),
    },
    outputSchema: {
      quoteId: z.string(),
      customer: z.object({
        customerId: z.string(),
        name: z.string(),
        tier: z.string(),
        discountPercent: z.number(),
      }),
      lines: z.array(
        z.object({
          sku: z.string(),
          name: z.string(),
          quantity: z.number(),
          unitPrice: z.number(),
          subtotal: z.number(),
        }),
      ),
      subtotal: z.number(),
      discount: z.number(),
      total: z.number(),
      warnings: z.array(z.string()),
    },
  },
  async ({ customerId, items }) => {
    const customer = customers[customerId as keyof typeof customers];

    if (customer === undefined) {
      throw new Error(`Unknown customer: ${customerId}`);
    }

    const lines = items.map(({ sku, quantity }) => {
      const product = findProduct(sku);

      return {
        sku,
        name: product.name,
        quantity,
        unitPrice: product.unitPrice,
        subtotal: roundMoney(product.unitPrice * quantity),
      };
    });
    const subtotal = roundMoney(
      lines.reduce((total, line) => total + line.subtotal, 0),
    );
    const discount = roundMoney(
      subtotal * (customer.discountPercent / 100),
    );
    const total = roundMoney(subtotal - discount);
    const warnings = items
      .map(({ sku, quantity }) => {
        const product = findProduct(sku);

        return product.stock < quantity
          ? `${sku} only has ${product.stock} units available`
          : undefined;
      })
      .filter((warning): warning is string => warning !== undefined);

    return asJsonToolResult({
      quoteId: `quote-${customerId}-${items.length}-${Math.round(total * 100)}`,
      customer,
      lines,
      subtotal,
      discount,
      total,
      warnings,
    });
  },
);

const findProduct = (sku: string): (typeof products)[number] => {
  const product = products.find((item) => item.sku === sku);

  if (product === undefined) {
    throw new Error(`Unknown SKU: ${sku}`);
  }

  return product;
};

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

const asJsonToolResult = (value: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

await server.connect(new StdioServerTransport());
