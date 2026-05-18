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

interface CodeModeSearchResult {
  readonly servers: ReadonlyArray<CodeModeServer>;
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
  readonly inputSchemaAvailable: true;
  readonly outputSchemaAvailable?: true;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

interface CodeModeToolSchema {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly originalToolName: string;
  readonly jsToolName: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly outputSchemaInvalid?: true;
  readonly annotations?: unknown;
}

interface CodeModeServerDeclaration {
  readonly serverName: string;
  readonly jsServerName: string;
  readonly declaration: string;
}

interface CodeModeDiagnostic {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly serverName: string;
  readonly toolName?: string;
  readonly message: string;
}

interface ContextResponse {
  readonly context: CodeModeSearchResult;
  readonly summary: {
    readonly serverCount: number;
    readonly toolCount: number;
    readonly diagnosticCount: number;
  };
}

interface ToolSchemaResponse {
  readonly tools: ReadonlyArray<CodeModeToolSchema>;
  readonly declarationsByServer: ReadonlyArray<CodeModeServerDeclaration>;
  readonly diagnostics: ReadonlyArray<CodeModeDiagnostic>;
}

type SchemaTab = "input" | "output" | "annotations" | "declarations";
type SchemaRequestCall = "search" | "get_tool_schema";
type SchemaResultTab = "declarations" | "schemas" | "request" | "raw";
type PlaygroundScreen = "schema" | "inspector" | "execute";

const EMPTY_CONTEXT: CodeModeSearchResult = {
  servers: [],
  diagnostics: [],
};

export function App() {
  return (
    <TooltipProvider>
      <Playground />
    </TooltipProvider>
  );
}

function ToolListPanel({
  title,
  selectedServer,
  selectedToolKey,
  onSelectTool,
}: {
  readonly title: string;
  readonly selectedServer: CodeModeServer | undefined;
  readonly selectedToolKey: string | undefined;
  readonly onSelectTool: (server: CodeModeServer, tool: CodeModeTool) => void;
}) {
  return (
    <Card className="min-h-64 shadow-sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardAction>
          <Badge variant="secondary">{selectedServer?.tools.length ?? 0} tools</Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-88 xl:h-[calc(100vh-15rem)]">
          <div className="flex flex-col gap-2 pr-2">
            {selectedServer === undefined || selectedServer.tools.length === 0 ? (
              <EmptyLine text="No tools match this view." />
            ) : (
              selectedServer.tools.map((tool) => {
                const key = getToolKey(selectedServer, tool);
                return (
                  <Button
                    key={key}
                    type="button"
                    variant={selectedToolKey === key ? "secondary" : "outline"}
                    className="h-auto justify-start px-3 py-2"
                    onClick={() => onSelectTool(selectedServer, tool)}
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
  );
}

function SchemaRequestPanel({
  activeCall,
  status,
  requestText,
  responseText,
  schemaResponse,
  isLoading,
  searchQuery,
  setSearchQuery,
  tools,
  selectedToolKeys,
  onToggleTool,
  onSelectAllTools,
  onClearToolSelection,
  search,
  getSchemas,
}: {
  readonly activeCall: SchemaRequestCall;
  readonly status: string;
  readonly requestText: string;
  readonly responseText: string;
  readonly schemaResponse: ToolSchemaResponse | undefined;
  readonly isLoading: boolean;
  readonly searchQuery: string;
  readonly setSearchQuery: (value: string) => void;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly selectedToolKeys: ReadonlyArray<string>;
  readonly onToggleTool: (key: string) => void;
  readonly onSelectAllTools: () => void;
  readonly onClearToolSelection: () => void;
  readonly search: () => void;
  readonly getSchemas: () => void;
}) {
  return (
    <Card className="min-w-0 overflow-hidden shadow-sm">
      <CardHeader className="border-b">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Schema Request</CardTitle>
              <CardDescription>
                Search tools, select a batch, and verify declarations.
              </CardDescription>
            </div>
            <Badge variant="outline">Last: {activeCall}</Badge>
          </div>

        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <Input
            value={searchQuery}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setSearchQuery(event.target.value)
            }
            placeholder="Search query for /api/context"
            aria-label="Schema request search query"
            className="min-w-0"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={isLoading}
          >
            <SearchIcon data-icon="inline-start" />
            Search
          </Button>
        </form>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid min-h-[calc(100vh-12rem)] lg:grid-cols-[24rem_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col border-b bg-muted/20 lg:border-b-0 lg:border-r">
            <div className="flex flex-wrap items-center gap-2 border-b p-4">
              <Badge variant="secondary">{tools.length} tools</Badge>
              <Badge variant="secondary">{selectedToolKeys.length} selected</Badge>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onSelectAllTools}
                  disabled={isLoading || tools.length === 0}
                >
                  All
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onClearToolSelection}
                  disabled={isLoading || selectedToolKeys.length === 0}
                >
                  Clear
                </Button>
              </div>
            </div>

            <ScrollArea className="h-[28rem] lg:h-[calc(100vh-18rem)]">
              <div className="flex flex-col gap-1 p-3">
                {tools.length === 0 ? (
                  <EmptyLine text="Run search to load tools." />
                ) : (
                  tools.map((entry) => {
                    const selected = selectedToolKeys.includes(entry.key);

                    return (
                      <button
                        key={entry.key}
                        type="button"
                        className={cn(
                          "flex w-full min-w-0 items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors",
                          selected
                            ? "border-primary/40 bg-primary/10"
                            : "border-transparent bg-background hover:bg-muted",
                        )}
                        onClick={() => onToggleTool(entry.key)}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold",
                            selected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background",
                          )}
                        >
                          {selected ? "✓" : ""}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate font-mono text-xs font-medium">
                            {entry.server.jsServerName}.{entry.tool.jsToolName}
                          </span>
                          <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                            {entry.tool.description ??
                              entry.tool.title ??
                              entry.tool.originalToolName}
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </aside>

          <div className="flex min-w-0 flex-col gap-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground">{status}</p>
              <Button
                type="button"
                onClick={getSchemas}
                disabled={isLoading || selectedToolKeys.length === 0}
              >
                get_tool_schema
              </Button>
            </div>

            <SchemaResponseTabs
              key={schemaResponse === undefined ? "empty" : responseText}
              requestText={requestText}
              responseText={responseText}
              schemaResponse={schemaResponse}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SchemaResponseTabs({
  requestText,
  responseText,
  schemaResponse,
}: {
  readonly requestText: string;
  readonly responseText: string;
  readonly schemaResponse: ToolSchemaResponse | undefined;
}) {
  const [tab, setTab] = useState<SchemaResultTab>(
    schemaResponse === undefined ? "request" : "declarations",
  );
  const tabs =
    schemaResponse === undefined
      ? ([
          ["request", "Request"],
          ["raw", "Response"],
        ] as const)
      : ([
          ["declarations", "Declarations"],
          ["schemas", "Tool schemas"],
          ["request", "Request"],
          ["raw", "Raw response"],
        ] as const);
  const activeTab = tabs.some(([value]) => value === tab) ? tab : tabs[0][0];
  const text =
    activeTab === "declarations"
      ? formatDeclarationBundles(schemaResponse?.declarationsByServer ?? [])
      : activeTab === "schemas"
        ? formatJson(schemaResponse?.tools ?? [])
        : activeTab === "request"
          ? requestText
          : responseText;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex h-8 items-center rounded-lg bg-muted p-1 text-muted-foreground">
          {tabs.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "inline-flex h-[calc(100%-2px)] items-center justify-center rounded-md px-3 text-sm font-medium transition-all",
                activeTab === value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {schemaResponse === undefined ? null : (
          <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary">
            {schemaResponse.declarationsByServer.length} server bundles
          </Badge>
          <Badge variant="secondary">{schemaResponse.tools.length} tools</Badge>
        </div>
        )}
      </div>
      <CodeBlock text={text} className="h-[32rem]" />
    </div>
  );
}

function InspectorPanel({
  selectedServer,
  selectedToolKey,
  selected,
  schema,
  declaration,
  schemaStatus,
  schemaTab,
  setSchemaTab,
  selectTool,
}: {
  readonly selectedServer: CodeModeServer | undefined;
  readonly selectedToolKey: string | undefined;
  readonly selected: ToolEntry | undefined;
  readonly schema: CodeModeToolSchema | undefined;
  readonly declaration: CodeModeServerDeclaration | undefined;
  readonly schemaStatus: string;
  readonly schemaTab: SchemaTab;
  readonly setSchemaTab: (value: SchemaTab) => void;
  readonly selectTool: (server: CodeModeServer, tool: CodeModeTool) => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
      <ToolListPanel
        title="Tools"
        selectedServer={selectedServer}
        selectedToolKey={selectedToolKey}
        onSelectTool={selectTool}
      />

      <div className="grid min-w-0 gap-4">
        <ToolInspector
          selected={selected}
          schema={schema}
          declaration={declaration}
          schemaStatus={schemaStatus}
          schemaTab={schemaTab}
          setSchemaTab={setSchemaTab}
        />
      </div>
    </div>
  );
}

function SchemaRequestScreen() {
  const [activeCall, setActiveCall] = useState<SchemaRequestCall>("search");
  const [status, setStatus] = useState(
    "Run search, select one or more returned tools, then request schemas.",
  );
  const [requestText, setRequestText] = useState("{}");
  const [responseText, setResponseText] = useState("{}");
  const [schemaResponse, setSchemaResponse] = useState<ToolSchemaResponse>();
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] =
    useState<CodeModeSearchResult>(EMPTY_CONTEXT);
  const [selectedToolKeys, setSelectedToolKeys] =
    useState<ReadonlyArray<string>>([]);
  const tools = useMemo(() => flattenTools(searchResult.servers), [searchResult]);

  useEffect(() => {
    void runSearch();
  }, []);

  const runSearch = async () => {
    const trimmed = searchQuery.trim();
    const request = trimmed.length === 0 ? {} : { query: trimmed };

    await runRequest("search", request, async () => {
      const params = new URLSearchParams();
      if (trimmed.length > 0) {
        params.set("query", trimmed);
      }

      const response = await fetch(
        `/api/context${params.size === 0 ? "" : `?${params}`}`,
      );
      const payload = await readJson<ContextResponse>(response);

      setSearchResult(payload.context);
      setSelectedToolKeys([]);
      setSchemaResponse(undefined);

      return payload.context;
    });
  };

  const runBatchSchemaRequest = async () => {
    if (selectedToolKeys.length === 0) {
      setStatus("Select one or more tools from search results first.");
      return;
    }

    const request = {
      tools: tools
        .filter((entry) => selectedToolKeys.includes(entry.key))
        .map((entry) => ({
          jsServerName: entry.server.jsServerName,
          jsToolName: entry.tool.jsToolName,
        })),
    };

    await runRequest("get_tool_schema", request, async () => {
      const response = await fetch("/api/tool-schema", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = await readJson<unknown>(response);
      const parsed = parseToolSchemaResponse(payload);

      setSchemaResponse(parsed);

      return payload;
    });
  };

  const runRequest = async (
    call: SchemaRequestCall,
    request: unknown,
    run: () => Promise<unknown>,
  ) => {
    setIsLoading(true);
    setActiveCall(call);
    setRequestText(formatJson(request));
    setResponseText("");

    if (call === "search") {
      setSchemaResponse(undefined);
    }

    setStatus(`Calling ${call}...`);

    try {
      const payload = await run();
      setResponseText(formatJson(payload));
      setStatus(getSchemaRequestStatus(call, payload));
    } catch (error) {
      const message = getErrorMessage(error);
      setResponseText(formatJson({ error: message }));
      setSchemaResponse(undefined);
      setStatus(`${call} failed: ${message}`);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleTool = (key: string) => {
    setSelectedToolKeys((current) =>
      current.includes(key)
        ? current.filter((candidate) => candidate !== key)
        : [...current, key],
    );
  };

  return (
    <SchemaRequestPanel
      activeCall={activeCall}
      status={status}
      requestText={requestText}
      responseText={responseText}
      schemaResponse={schemaResponse}
      isLoading={isLoading}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      tools={tools}
      selectedToolKeys={selectedToolKeys}
      onToggleTool={toggleTool}
      onSelectAllTools={() => setSelectedToolKeys(tools.map((entry) => entry.key))}
      onClearToolSelection={() => setSelectedToolKeys([])}
      search={() => void runSearch()}
      getSchemas={() => void runBatchSchemaRequest()}
    />
  );
}

function InspectorScreen() {
  const [query, setQuery] = useState("");
  const [context, setContext] = useState<CodeModeSearchResult>(EMPTY_CONTEXT);
  const [summary, setSummary] = useState<ContextResponse["summary"]>({
    serverCount: 0,
    toolCount: 0,
    diagnosticCount: 0,
  });
  const [selectedServerName, setSelectedServerName] = useState<string>();
  const [selectedToolKey, setSelectedToolKey] = useState<string>();
  const [schemaTab, setSchemaTab] = useState<SchemaTab>("input");
  const [status, setStatus] = useState("Loading inspector search...");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedSchema, setSelectedSchema] = useState<CodeModeToolSchema>();
  const [selectedDeclaration, setSelectedDeclaration] =
    useState<CodeModeServerDeclaration>();
  const [schemaStatus, setSchemaStatus] = useState("");

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
      (selectedServer === undefined || selectedServer.tools[0] === undefined
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
      setSelectedSchema(undefined);
      setSelectedDeclaration(undefined);
      setSchemaStatus("");
      return;
    }

    const controller = new AbortController();
    void loadToolSchema(selected, controller.signal);

    return () => controller.abort();
  }, [selected?.key]);

  const loadContext = async (nextQuery = query) => {
    setIsLoading(true);
    setStatus("Loading inspector search...");

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
      setStatus("Inspector search loaded.");
    } catch (error) {
      setStatus(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  const loadToolSchema = async (
    entry: ToolEntry,
    signal: AbortSignal,
  ) => {
    setSelectedSchema(undefined);
    setSelectedDeclaration(undefined);
    setSchemaStatus("Loading selected tool schema...");

    try {
      const response = await fetch("/api/tool-schema", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          tools: [
            {
              jsServerName: entry.server.jsServerName,
              jsToolName: entry.tool.jsToolName,
            },
          ],
        }),
      });
      const payload = parseToolSchemaResponse(await readJson<unknown>(response));
      const schema = payload.tools.find(
        (item) =>
          item.jsServerName === entry.server.jsServerName &&
          item.jsToolName === entry.tool.jsToolName,
      );
      const declaration =
        payload.declarationsByServer.find(
          (item) => item.jsServerName === entry.server.jsServerName,
        ) ?? payload.declarationsByServer[0];

      if (schema === undefined) {
        throw new Error("Tool schema response did not include the selected tool.");
      }

      if (declaration === undefined) {
        throw new Error(
          "Tool schema response did not include the selected tool declaration.",
        );
      }

      setSelectedSchema(schema);
      setSelectedDeclaration(declaration);
      setSchemaStatus("Selected tool schema loaded.");
    } catch (error) {
      if (!signal.aborted) {
        setSelectedSchema(undefined);
        setSelectedDeclaration(undefined);
        setSchemaStatus(getErrorMessage(error));
      }
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
    <div className="grid gap-4">
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle>Inspector Search</CardTitle>
          <CardDescription>{status}</CardDescription>
          <CardAction>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadContext(query)}
              disabled={isLoading}
            >
              <RefreshCwIcon data-icon="inline-start" />
              Refresh
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadContext(query);
            }}
          >
            <Input
              value={query}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setQuery(event.target.value)
              }
              placeholder="Filter tools"
              aria-label="Filter inspector tools"
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

          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {context.servers.map((server) => (
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
            ))}
          </div>
        </CardContent>
      </Card>

      {context.diagnostics.length === 0 ? null : (
        <Diagnostics diagnostics={context.diagnostics} />
      )}

      <InspectorPanel
        selectedServer={selectedServer}
        selectedToolKey={selected?.key}
        selected={selected}
        schema={selectedSchema}
        declaration={selectedDeclaration}
        schemaStatus={schemaStatus}
        schemaTab={schemaTab}
        setSchemaTab={setSchemaTab}
        selectTool={selectTool}
      />
    </div>
  );
}

function ExecuteScreen() {
  const [code, setCode] = useState("async () => {\n  return null;\n}");
  const [result, setResult] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [isRunning, setIsRunning] = useState(false);

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

  return (
    <ExecutionPanel
      code={code}
      setCode={setCode}
      result={result}
      runStatus={runStatus}
      isRunning={isRunning}
      disabled={false}
      execute={() => void execute()}
    />
  );
}

function Playground() {
  const [screen, setScreen] = useState<PlaygroundScreen>("schema");

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="border-border bg-card p-4 lg:border-r lg:border-b shadow-sm">
        <div className="flex flex-col gap-6">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-md">
              <DatabaseZapIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold tracking-tight">
                ptools MCP Playground
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Separate screens for discovery, inspection, and execution.
              </p>
            </div>
          </div>

          <nav className="flex flex-col gap-2">
            {([
              ["schema", "Schema Request", DatabaseZapIcon],
              ["inspector", "Inspector", BracesIcon],
              ["execute", "Execute", PlayIcon],
            ] as const).map(([value, label, Icon]) => (
              <Button
                key={value}
                type="button"
                variant={screen === value ? "secondary" : "outline"}
                className="justify-start"
                onClick={() => setScreen(value)}
              >
                <Icon data-icon="inline-start" />
                {label}
              </Button>
            ))}
          </nav>
        </div>
      </aside>

      <section className="flex min-w-0 flex-col gap-4 p-4">
        <header>
          <h2 className="text-xl font-bold tracking-tight">
            {screen === "schema"
              ? "Schema Request"
              : screen === "inspector"
                ? "Inspector"
                : "Execute"}
          </h2>
        </header>

        {screen === "schema" ? (
          <SchemaRequestScreen />
        ) : screen === "inspector" ? (
          <InspectorScreen />
        ) : (
          <ExecuteScreen />
        )}
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
  schema,
  declaration,
  schemaStatus,
  schemaTab,
  setSchemaTab,
}: {
  readonly selected: ToolEntry | undefined;
  readonly schema: CodeModeToolSchema | undefined;
  readonly declaration: CodeModeServerDeclaration | undefined;
  readonly schemaStatus: string;
  readonly schemaTab: SchemaTab;
  readonly setSchemaTab: (value: SchemaTab) => void;
}) {
  const textFor = (tab: SchemaTab): string =>
    selected === undefined
      ? ""
      : getSchemaText(selected.tool, schema, declaration, tab, schemaStatus);

  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader>
        <CardTitle className="font-mono text-sm">
          {selected === undefined
            ? "Select a tool"
            : `${selected.server.jsServerName}.${selected.tool.jsToolName}`}
        </CardTitle>
        <CardDescription>
          Original mapping, selected schema metadata, and declaration slice.
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

const formatDeclarationBundles = (
  declarations: ReadonlyArray<CodeModeServerDeclaration>,
): string => {
  if (declarations.length === 0) {
    return "// No declarations returned";
  }

  return declarations
    .map(
      (entry) =>
        `// ${entry.jsServerName} (${entry.serverName})\n${entry.declaration.trimEnd()}`,
    )
    .join("\n\n");
};

const getSchemaText = (
  tool: CodeModeTool,
  schema: CodeModeToolSchema | undefined,
  declaration: CodeModeServerDeclaration | undefined,
  tab: SchemaTab,
  schemaStatus: string,
): string => {
  if (schema === undefined) {
    return schemaStatus.length === 0 ? "Select a tool to load schema." : schemaStatus;
  }

  if (tab === "input") {
    return formatJson(schema.inputSchema);
  }

  if (tab === "output") {
    return formatJson(
      schema.outputSchemaInvalid
        ? {
            note: "Invalid output schema; declarations use unknown.",
            outputSchema: schema.outputSchema,
          }
        : (schema.outputSchema ?? null),
    );
  }

  if (tab === "annotations") {
    return formatJson(schema.annotations ?? tool.annotations ?? null);
  }

  return declaration?.declaration ?? "Selected tool declaration was not returned.";
};

const makeExecuteSnippet = (
  server: CodeModeServer,
  tool: CodeModeTool,
  schema?: CodeModeToolSchema,
): string => {
  const sampleInput = sampleFromSchema(schema?.inputSchema);
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

const getSchemaRequestStatus = (
  tool: SchemaRequestCall,
  payload: unknown,
): string => {
  if (tool !== "get_tool_schema") {
    return `${tool} succeeded.`;
  }

  try {
    const parsed = parseToolSchemaResponse(payload);

    return `get_tool_schema returned ${parsed.tools.length} tool schema(s) and ${parsed.declarationsByServer.length} declaration block(s).`;
  } catch {
    return "get_tool_schema returned payload in an unrecognized shape; inspect response.";
  }
};

const parseToolSchemaResponse = (payload: unknown): ToolSchemaResponse => {
  const body = unwrapStructuredContent(payload);

  if (typeof body.error === "string" && body.error.length > 0) {
    throw new Error(body.error);
  }

  if (!Array.isArray(body.tools)) {
    throw new Error("Tool schema response did not include a tools array.");
  }

  const tools = body.tools.map(parseToolSchema);

  return {
    tools,
    declarationsByServer: parseDeclarationsByServer(body, tools),
    diagnostics: Array.isArray(body.diagnostics)
      ? body.diagnostics.map(parseDiagnostic)
      : [],
  };
};

const unwrapStructuredContent = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) {
    throw new Error("Tool schema response must be a JSON object.");
  }

  const structured = payload.structuredContent;

  if (isRecord(structured)) {
    return structured;
  }

  return payload;
};

const parseDeclarationsByServer = (
  body: Record<string, unknown>,
  tools: ReadonlyArray<CodeModeToolSchema>,
): ReadonlyArray<CodeModeServerDeclaration> => {
  if (Array.isArray(body.declarationsByServer)) {
    return body.declarationsByServer.map(parseServerDeclaration);
  }

  if (Array.isArray(body.declarations)) {
    return body.declarations.map((entry) =>
      parseLegacyDeclarationEntry(entry, tools[0]),
    );
  }

  if (typeof body.declarations === "string") {
    return [parseLegacyDeclarationEntry(body.declarations, tools[0])];
  }

  if (Array.isArray(body.tools)) {
    const fromTools = body.tools
      .map((entry) => parseToolLevelDeclaration(entry))
      .filter(
        (entry): entry is CodeModeServerDeclaration => entry !== undefined,
      );

    if (fromTools.length > 0) {
      return fromTools;
    }
  }

  throw new Error("Tool schema response did not include declaration content.");
};

const parseLegacyDeclarationEntry = (
  value: unknown,
  firstTool?: CodeModeToolSchema,
): CodeModeServerDeclaration => {
  if (typeof value === "string") {
    return {
      serverName: firstTool?.serverName ?? "unknown",
      jsServerName: firstTool?.jsServerName ?? "unknown",
      declaration: value,
    };
  }

  if (!isRecord(value)) {
    throw new Error(
      "Tool schema response included a non-object legacy declaration entry.",
    );
  }

  return {
    serverName:
      typeof value.serverName === "string" && value.serverName.trim().length > 0
        ? value.serverName.trim()
        : (firstTool?.serverName ?? "unknown"),
    jsServerName:
      typeof value.jsServerName === "string" &&
      value.jsServerName.trim().length > 0
        ? value.jsServerName.trim()
        : (firstTool?.jsServerName ?? "unknown"),
    declaration: expectStringField(value, "declaration"),
  };
};

const parseToolLevelDeclaration = (
  value: unknown,
): CodeModeServerDeclaration | undefined => {
  if (!isRecord(value) || typeof value.declaration !== "string") {
    return undefined;
  }

  return {
    serverName:
      typeof value.serverName === "string" && value.serverName.trim().length > 0
        ? value.serverName.trim()
        : "unknown",
    jsServerName:
      typeof value.jsServerName === "string" &&
      value.jsServerName.trim().length > 0
        ? value.jsServerName.trim()
        : "unknown",
    declaration: value.declaration,
  };
};

const parseToolSchema = (value: unknown): CodeModeToolSchema => {
  if (!isRecord(value)) {
    throw new Error("Tool schema response included a non-object tool entry.");
  }

  const serverName = expectNonEmptyStringField(value, "serverName");
  const jsServerName = expectNonEmptyStringField(value, "jsServerName");
  const originalToolName = expectNonEmptyStringField(value, "originalToolName");
  const jsToolName = expectNonEmptyStringField(value, "jsToolName");

  return {
    serverName,
    jsServerName,
    originalToolName,
    jsToolName,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string"
      ? { description: value.description }
      : {}),
    inputSchema: value.inputSchema,
    ...("outputSchema" in value ? { outputSchema: value.outputSchema } : {}),
    ...(value.outputSchemaInvalid === true ? { outputSchemaInvalid: true } : {}),
    ...("annotations" in value ? { annotations: value.annotations } : {}),
  };
};

const parseServerDeclaration = (value: unknown): CodeModeServerDeclaration => {
  if (!isRecord(value)) {
    throw new Error(
      "Tool schema response included a non-object declaration entry.",
    );
  }

  return {
    serverName:
      typeof value.serverName === "string" && value.serverName.trim().length > 0
        ? value.serverName.trim()
        : "unknown",
    jsServerName:
      typeof value.jsServerName === "string" &&
      value.jsServerName.trim().length > 0
        ? value.jsServerName.trim()
        : "unknown",
    declaration: expectStringField(value, "declaration"),
  };
};

const parseDiagnostic = (value: unknown): CodeModeDiagnostic => {
  if (!isRecord(value)) {
    throw new Error(
      "Tool schema response included a non-object diagnostic entry.",
    );
  }

  const severity = value.severity;

  if (severity !== "error" && severity !== "warning") {
    throw new Error("Tool schema response included a diagnostic with invalid severity.");
  }

  return {
    code: expectNonEmptyStringField(value, "code"),
    severity,
    serverName: expectNonEmptyStringField(value, "serverName"),
    ...(typeof value.toolName === "string" ? { toolName: value.toolName } : {}),
    message: expectStringField(value, "message"),
  };
};

const expectStringField = (
  value: Record<string, unknown>,
  field: string,
): string => {
  const next = value[field];

  if (typeof next !== "string") {
    throw new Error(`Tool schema response field '${field}' must be a string.`);
  }

  return next;
};

const expectNonEmptyStringField = (
  value: Record<string, unknown>,
  field: string,
): string => {
  const next = expectStringField(value, field).trim();

  if (next.length === 0) {
    throw new Error(
      `Tool schema response field '${field}' must be a non-empty string.`,
    );
  }

  return next;
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const formatJson = (value: unknown): string =>
  JSON.stringify(value ?? null, null, 2);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
