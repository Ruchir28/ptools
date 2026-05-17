import React, { useEffect, useMemo, useState } from "react";
import {
  BracesIcon,
  DatabaseZapIcon,
  PlayIcon,
  RefreshCwIcon,
  SearchIcon,
  ServerIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface CodeModeContext {
  readonly servers: ReadonlyArray<CodeModeServer>;
  readonly declarations: string;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

interface CodeModeServer {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly tools: ReadonlyArray<CodeModeTool>;
}

interface CodeModeTool {
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

interface CodeModeDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly serverName: string;
  readonly toolName?: string;
  readonly message: string;
}

interface ContextResponse {
  readonly context: CodeModeContext;
  readonly summary: {
    readonly serverCount: number;
    readonly toolCount: number;
    readonly diagnosticCount: number;
  };
}

type SchemaTab = "input" | "output" | "annotations" | "declarations";

const EMPTY_CONTEXT: CodeModeContext = {
  servers: [],
  declarations: "",
  diagnostics: [],
};

export function App() {
  return (
    <TooltipProvider>
      <Playground />
    </TooltipProvider>
  );
}

function Playground() {
  const [query, setQuery] = useState("");
  const [context, setContext] = useState<CodeModeContext>(EMPTY_CONTEXT);
  const [summary, setSummary] = useState<ContextResponse["summary"]>({
    serverCount: 0,
    toolCount: 0,
    diagnosticCount: 0,
  });
  const [selectedServerName, setSelectedServerName] = useState<string>();
  const [selectedToolKey, setSelectedToolKey] = useState<string>();
  const [schemaTab, setSchemaTab] = useState<SchemaTab>("input");
  const [code, setCode] = useState("");
  const [result, setResult] = useState("");
  const [status, setStatus] = useState("Loading MCP registry...");
  const [runStatus, setRunStatus] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [toolDeclarations, setToolDeclarations] = useState("");

  const tools = useMemo(() => flattenTools(context.servers), [context.servers]);
  const selectedServer = useMemo(
    () =>
      context.servers.find((server) => server.jsServerName === selectedServerName) ??
      context.servers[0],
    [context.servers, selectedServerName],
  );
  const selected = useMemo(
    () =>
      tools.find((entry) => entry.key === selectedToolKey) ??
      (selectedServer === undefined
        ? undefined
        : selectedServer.tools[0] === undefined
          ? undefined
          : {
              key: getToolKey(selectedServer, selectedServer.tools[0]),
              server: selectedServer,
              tool: selectedServer.tools[0],
            }),
    [selectedServer, selectedToolKey, tools],
  );

  useEffect(() => {
    void loadContext("");
  }, []);

  useEffect(() => {
    if (selected === undefined) {
      setCode("");
      setToolDeclarations("");
      return;
    }

    setCode(makeExecuteSnippet(selected.server, selected.tool));
    setToolDeclarations("");
  }, [selected?.key]);

  useEffect(() => {
    if (selected === undefined || schemaTab !== "declarations") {
      return;
    }

    const controller = new AbortController();
    void loadToolDeclarations(selected, controller.signal);

    return () => controller.abort();
  }, [schemaTab, selected?.key]);

  const loadContext = async (nextQuery = query) => {
    setIsLoading(true);
    setStatus("Loading MCP registry...");

    try {
      const params = new URLSearchParams();
      const trimmed = nextQuery.trim();
      if (trimmed.length > 0) {
        params.set("query", trimmed);
      }

      const response = await fetch(
        `/api/context${params.size === 0 ? "" : `?${params}`}`,
      );
      const payload = await readJson<ContextResponse>(response);
      const nextTools = flattenTools(payload.context.servers);
      const nextSelected = nextTools.some((tool) => tool.key === selectedToolKey)
        ? selectedToolKey
        : nextTools[0]?.key;

      setContext(payload.context);
      setSummary(payload.summary);
      setSelectedToolKey(nextSelected);
      setSelectedServerName(
        nextSelected === undefined
          ? payload.context.servers[0]?.jsServerName
          : nextTools.find((tool) => tool.key === nextSelected)?.server.jsServerName,
      );
      setStatus("Loaded from live CodeMode registry.");
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const loadToolDeclarations = async (
    entry: ToolEntry,
    signal: AbortSignal,
  ) => {
    setToolDeclarations("Loading selected tool declarations...");

    try {
      const params = new URLSearchParams({
        server: entry.server.jsServerName,
        tool: entry.tool.jsToolName,
      });
      const response = await fetch(`/api/tool-declarations?${params}`, {
        signal,
      });
      const payload = await readJson<{ readonly declarations: string }>(response);

      setToolDeclarations(payload.declarations);
    } catch (error) {
      if (!signal.aborted) {
        setToolDeclarations(getErrorMessage(error));
      }
    }
  };

  const execute = async () => {
    setIsRunning(true);
    setRunStatus("Running...");
    setResult("");

    try {
      const response = await fetch("/api/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await readJson<unknown>(response);
      setResult(formatJson(payload));
      setRunStatus("Done");
    } catch (error) {
      setResult(formatJson({ error: getErrorMessage(error) }));
      setRunStatus("Failed");
    } finally {
      setIsRunning(false);
    }
  };

  const selectServer = (server: CodeModeServer) => {
    setSelectedServerName(server.jsServerName);
    setSelectedToolKey(
      server.tools[0] === undefined ? undefined : getToolKey(server, server.tools[0]),
    );
  };

  const selectTool = (server: CodeModeServer, tool: CodeModeTool) => {
    setSelectedServerName(server.jsServerName);
    setSelectedToolKey(getToolKey(server, tool));
  };

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground lg:grid lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside className="border-border bg-card p-4 lg:border-r lg:border-b shadow-sm">
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md">
              <DatabaseZapIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold tracking-tight">
                ptools MCP Playground
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Inspect generated APIs, schemas, diagnostics, and execution.
              </p>
            </div>
          </div>

          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadContext(query);
            }}
          >
            <Input
              value={query}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
              placeholder="Filter tools"
              aria-label="Filter tools"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="submit" variant="outline" size="icon" aria-label="Search">
                  <SearchIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Search tools</TooltipContent>
            </Tooltip>
          </form>

          <div className="grid grid-cols-3 gap-2">
            <Metric label="Servers" value={summary.serverCount} />
            <Metric label="Tools" value={summary.toolCount} />
            <Metric label="Issues" value={summary.diagnosticCount} />
          </div>

          <ScrollArea className="h-[calc(100vh-15rem)] pr-2">
            <div className="flex flex-col gap-2">
              {context.servers.length === 0 ? (
                <EmptyLine text="No connected MCP servers." />
              ) : (
                context.servers.map((server) => (
                  <Button
                    key={server.jsServerName}
                    type="button"
                    variant={
                      server.jsServerName === selectedServer?.jsServerName
                        ? "secondary"
                        : "outline"
                    }
                    className="h-auto justify-start px-3 py-2"
                    onClick={() => selectServer(server)}
                  >
                    <ServerIcon data-icon="inline-start" />
                    <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                      <span className="max-w-full truncate font-mono text-xs">
                        {server.jsServerName}
                      </span>
                      <span className="max-w-full truncate text-xs text-muted-foreground">
                        {server.serverName === server.jsServerName
                          ? "Original name unchanged"
                          : `Original: ${server.serverName}`}
                      </span>
                    </span>
                    <Badge variant="outline">{server.tools.length}</Badge>
                  </Button>
                ))
              )}
            </div>
          </ScrollArea>
        </div>
      </aside>

      <section className="flex min-w-0 flex-col gap-4 p-4">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-tight">API Surface</h2>
            <p className="text-sm text-muted-foreground leading-relaxed">{status}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadContext(query)}
            disabled={isLoading}
          >
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </header>

        {context.diagnostics.length > 0 ? (
          <Diagnostics diagnostics={context.diagnostics} />
        ) : null}

        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <Card className="min-h-64 shadow-sm">
            <CardHeader>
              <CardTitle>Tools</CardTitle>
              <CardAction>
                <Badge variant="secondary">
                  {selectedServer?.tools.length ?? 0} tools
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-88 xl:h-[calc(100vh-15rem)]">
                <div className="flex flex-col gap-2 pr-2">
                  {selectedServer === undefined ||
                  selectedServer.tools.length === 0 ? (
                    <EmptyLine text="No tools match this view." />
                  ) : (
                    selectedServer.tools.map((tool) => {
                      const key = getToolKey(selectedServer, tool);
                      return (
                        <Button
                          key={key}
                          type="button"
                          variant={selected?.key === key ? "secondary" : "outline"}
                          className="h-auto justify-start px-3 py-2"
                          onClick={() => selectTool(selectedServer, tool)}
                        >
                          <BracesIcon data-icon="inline-start" />
                          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                            <span className="max-w-full truncate font-mono text-xs">
                              {selectedServer.jsServerName}.{tool.jsToolName}
                            </span>
                            <span className="max-w-full truncate text-xs text-muted-foreground">
                              {tool.title ?? tool.description ?? tool.originalToolName}
                            </span>
                          </span>
                        </Button>
                      );
                    })
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>

          <div className="grid min-w-0 gap-4">
            <ToolInspector
              selected={selected}
              schemaTab={schemaTab}
              setSchemaTab={setSchemaTab}
              declarations={toolDeclarations}
            />
            <ExecutionPanel
              code={code}
              setCode={setCode}
              result={result}
              runStatus={runStatus}
              isRunning={isRunning}
              disabled={selected === undefined}
              execute={() => void execute()}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <Card size="sm" className="shadow-sm">
      <CardContent className="flex flex-col gap-1">
        <span className="text-lg font-bold leading-none text-foreground">{value}</span>
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</span>
      </CardContent>
    </Card>
  );
}

function Diagnostics({
  diagnostics,
}: {
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlertIcon />
          Diagnostics
        </CardTitle>
        <CardDescription>Registry connection and schema warnings.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {diagnostics.map((diagnostic, index) => (
          <div
            key={`${diagnostic.serverName}-${diagnostic.toolName ?? "server"}-${index}`}
            className="rounded-lg border bg-muted/30 p-3 shadow-sm"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={
                  diagnostic.severity === "error" ? "destructive" : "secondary"
                }
              >
                {diagnostic.code}
              </Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {diagnostic.serverName}
                {diagnostic.toolName === undefined ? "" : `.${diagnostic.toolName}`}
              </span>
            </div>
            <p className="mt-2 text-sm">{diagnostic.message}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ToolInspector({
  selected,
  schemaTab,
  setSchemaTab,
  declarations,
}: {
  readonly selected: ToolEntry | undefined;
  readonly schemaTab: SchemaTab;
  readonly setSchemaTab: (value: SchemaTab) => void;
  readonly declarations: string;
}) {
  const textFor = (tab: SchemaTab): string =>
    selected === undefined ? "" : getSchemaText(selected.tool, tab, declarations);

  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader>
        <CardTitle className="font-mono text-sm">
          {selected === undefined
            ? "Select a tool"
            : `${selected.server.jsServerName}.${selected.tool.jsToolName}`}
        </CardTitle>
        <CardDescription>
          Original mapping, schema metadata, and selected declaration slice.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="w-full shrink-0 lg:w-52 lg:border-r lg:pr-5">
            {selected === undefined ? (
              <EmptyLine text="No tool selected." />
            ) : (
              <div className="flex flex-col gap-4">
                <Field label="Generated call" value={`${selected.server.jsServerName}.${selected.tool.jsToolName}(input)`} />
                <Field label="Original server" value={selected.server.serverName} />
                <Field label="Original tool" value={selected.tool.originalToolName} />
                <Field label="Title" value={selected.tool.title ?? "-"} />
                <DescriptionField value={selected.tool.description ?? "-"} />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-3">
              <div className="inline-flex h-8 items-center justify-start rounded-lg bg-muted p-1 text-muted-foreground">
                {(["input", "output", "annotations", "declarations"] as SchemaTab[]).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSchemaTab(tab)}
                    className={cn(
                      "relative inline-flex h-[calc(100%-2px)] items-center justify-center rounded-md px-3 py-0.5 text-sm font-medium capitalize transition-all",
                      schemaTab === tab
                        ? "bg-background text-foreground shadow-sm"
                        : "text-foreground/60 hover:text-foreground",
                    )}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
              <CodeBlock text={textFor(schemaTab)} className="h-96" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ExecutionPanel({
  code,
  setCode,
  result,
  runStatus,
  isRunning,
  disabled,
  execute,
}: {
  readonly code: string;
  readonly setCode: (value: string) => void;
  readonly result: string;
  readonly runStatus: string;
  readonly isRunning: boolean;
  readonly disabled: boolean;
  readonly execute: () => void;
}) {
  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader>
        <CardTitle>Execute</CardTitle>
        <CardDescription>
          Runs generated JavaScript through the same Code Mode executor.
        </CardDescription>
        <CardAction>
          <Button type="button" onClick={execute} disabled={disabled || isRunning}>
            <PlayIcon data-icon="inline-start" />
            Run
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <Textarea
          value={code}
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setCode(event.target.value)}
          spellCheck={false}
          className="h-72 resize-none font-mono text-xs"
        />
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">Result</span>
            <span className="text-sm text-muted-foreground">{runStatus}</span>
          </div>
          <CodeBlock text={result} className="h-64" />
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <span className="break-all font-mono text-xs text-foreground">{value}</span>
      <Separator className="mt-2" />
    </div>
  );
}

function DescriptionField({ value }: { readonly value: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = value.length > 120;

  return (
    <div className="flex flex-col gap-1.5 pb-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Description
      </span>
      <span className={cn("text-sm text-foreground leading-relaxed", !expanded && isLong && "line-clamp-4")}>
        {value}
      </span>
      {isLong && (
        <button
          type="button"
          className="self-start text-xs text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function CodeBlock({
  text,
  className,
}: {
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <ScrollArea
      className={cn(
        "rounded-lg border bg-muted/50 shadow-sm",
        className,
      )}
    >
      <pre className="min-w-max p-4 font-mono text-xs leading-relaxed text-foreground">
        {text || "// No content"}
      </pre>
    </ScrollArea>
  );
}

function EmptyLine({ text }: { readonly text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/30 p-8 text-center">
      <DatabaseZapIcon className="size-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

interface ToolEntry {
  readonly key: string;
  readonly server: CodeModeServer;
  readonly tool: CodeModeTool;
}

const flattenTools = (servers: ReadonlyArray<CodeModeServer>): ReadonlyArray<ToolEntry> =>
  servers.flatMap((server) =>
    server.tools.map((tool) => ({
      key: getToolKey(server, tool),
      server,
      tool,
    })),
  );

const getToolKey = (server: CodeModeServer, tool: CodeModeTool): string =>
  `${server.jsServerName}.${tool.jsToolName}`;

const getSchemaText = (
  tool: CodeModeTool,
  tab: SchemaTab,
  declarations: string,
): string => {
  if (tab === "input") {
    return formatJson(tool.inputSchema);
  }

  if (tab === "output") {
    return formatJson(
      tool.outputSchemaInvalid
        ? {
            note: "Invalid output schema; declarations use unknown.",
            outputSchema: tool.outputSchema,
          }
        : (tool.outputSchema ?? null),
    );
  }

  if (tab === "annotations") {
    return formatJson(tool.annotations ?? null);
  }

  return declarations;
};

const makeExecuteSnippet = (
  server: CodeModeServer,
  tool: CodeModeTool,
): string => {
  const sampleInput = sampleFromSchema(tool.inputSchema);
  const input = formatJson(sampleInput)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");

  return [
    "async () => {",
    `  const result = await ${server.jsServerName}.${tool.jsToolName}(${input});`,
    "  return result;",
    "}",
  ].join("\n");
};

const sampleFromSchema = (schema: unknown): unknown => {
  if (!isRecord(schema)) {
    return {};
  }

  if ("default" in schema) {
    return schema.default;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  if (type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : Object.keys(properties).slice(0, 3);

    return Object.fromEntries(
      required.map((key) => [key, sampleFromSchema(properties[key])]),
    );
  }

  if (type === "array") {
    return [sampleFromSchema(schema.items)];
  }

  if (type === "string") {
    return "example";
  }

  if (type === "integer" || type === "number") {
    return 1;
  }

  if (type === "boolean") {
    return true;
  }

  return {};
};

const readJson = async <Value,>(response: Response): Promise<Value> => {
  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    throw new Error(getPayloadError(payload));
  }

  return payload as Value;
};

const getPayloadError = (payload: unknown): string => {
  if (isRecord(payload) && typeof payload.error === "string") {
    return payload.error;
  }

  return "Request failed";
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatJson = (value: unknown): string =>
  JSON.stringify(value ?? null, null, 2);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
