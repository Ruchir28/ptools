import type { HostMcpOAuthCallbackBrowserResponse } from "@ptools/host-api";

export const browserHtmlResponse = (
  status: number,
  body: string,
): HostMcpOAuthCallbackBrowserResponse => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8" },
  body,
});

export const renderMessagePage = (title: string, message: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; padding: 32px;">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>You may close this browser tab and return to ptools.</p>
</body>
</html>`;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
