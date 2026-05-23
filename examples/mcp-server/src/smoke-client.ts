import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const client = new Client({
  name: "ptools-mcp-server-example-client",
  version: "0.0.0",
});

const transport = new StdioClientTransport({
  command: "ptools-mcp",
  args: [],
  cwd: exampleRoot,
  stderr: "pipe",
});

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(
    "public tools:",
    tools.tools.map((tool) => tool.name).sort(),
  );

  const providers = await client.callTool({
    name: "search_providers",
    arguments: {},
  });
  console.log("providers:", providers.structuredContent);

  const search = await client.callTool({
    name: "search",
    arguments: { provider: "echo", query: "product inventory quote customer" },
  });
  console.log("search:", search.structuredContent);

  const schema = await client.callTool({
    name: "get_tool_schema",
    arguments: {
      toolIds: [
        "echo.list_products",
        "echo.get_customer_terms",
        "echo.check_inventory",
        "echo.create_quote",
      ],
    },
  });
  console.log("schema:", schema.structuredContent);

  const execution = await client.callTool({
    name: "execute",
    arguments: {
      code: `async () => {
        const catalog = await echo.list_products({ inStockOnly: true });
        const customer = await echo.get_customer_terms({ customerId: "cust-001" });
        const requestedItems = [
          { sku: "TEA-ASSAM-250", quantity: 6 },
          { sku: "COF-ARAB-500", quantity: 3 },
          { sku: "BIS-CARD-120", quantity: 8 }
        ];
        const inventory = await echo.check_inventory({ items: requestedItems });
        const adjustedItems = inventory.checks.map((item) => ({
          sku: item.sku,
          quantity: Math.min(item.requested, item.available)
        })).filter((item) => item.quantity > 0);
        const quote = await echo.create_quote({
          customerId: customer.customerId,
          items: adjustedItems
        });

        return { catalog, customer, requestedItems, inventory, adjustedItems, quote };
      }`,
    },
  });
  console.log("execution:", execution.structuredContent);
} finally {
  await client.close();
}
