import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Folio PDF Viewer — VS Code custom-editor spike.
 *
 * Proves the one genuine unknown in porting Folio to a VS Code webview: that
 * PDF.js (worker + assets) renders a real PDF under the webview's strict CSP.
 * It registers a read-only custom editor for `*.pdf`; the webview reads the file
 * through `webview.asWebviewUri` and renders every page to a canvas.
 *
 * The full port replaces the render-to-canvas webview with Folio's React app
 * and adds a save/dirty bridge; the extension host and asset plumbing here are
 * the parts that carry over.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'folio.pdfViewer',
      new FolioPdfEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );
}

export function deactivate(): void {
  // Nothing to clean up: subscriptions are disposed by VS Code.
}

/** A custom document is just the file URI; the bytes live on disk. */
class PdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {
    // No in-memory resources to release in the read-only spike.
  }
}

class FolioPdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const { webview } = panel;
    const outRoot = vscode.Uri.joinPath(this.context.extensionUri, 'out');
    const docRoot = vscode.Uri.joinPath(document.uri, '..');

    webview.options = {
      enableScripts: true,
      // Allow the webview to load its own bundle/worker AND the PDF being viewed.
      localResourceRoots: [outRoot, docRoot],
    };

    webview.html = this.render(webview, outRoot, document.uri);

    // Surface any render failure from the webview as a VS Code notification.
    panel.webview.onDidReceiveMessage((msg: { type: string; message?: string }) => {
      if (msg.type === 'error' && msg.message) {
        void vscode.window.showErrorMessage(`Folio: ${msg.message}`);
      }
    });
  }

  private render(webview: vscode.Webview, outRoot: vscode.Uri, pdfUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(outRoot, 'app.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(outRoot, 'app.css'));
    const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(outRoot, 'pdf.worker.min.mjs'));
    const pdfWebviewUri = webview.asWebviewUri(pdfUri);
    const name = path.basename(pdfUri.fsPath);
    const nonce = makeNonce();
    const csp = webview.cspSource;

    // Strict CSP. The interesting lines: worker-src must permit the PDF.js
    // worker, and connect-src must permit fetching the PDF resource by URL.
    // 'unsafe-inline' on style-src is required by React inline styles; scripts
    // stay nonce-locked.
    const cspContent = [
      "default-src 'none'",
      `connect-src ${csp}`,
      `img-src ${csp} data: blob:`,
      `style-src ${csp} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `worker-src ${csp} blob:`,
      `font-src ${csp} data:`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${cspContent}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <style>
    html, body, #root { height: 100%; }
    body { margin: 0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <div id="folio-data" data-pdf="${pdfWebviewUri}" data-name="${escapeHtml(name)}" hidden></div>
  <script nonce="${nonce}">
    globalThis.__FOLIO_ASSETS__ = { 'pdf.worker.min.mjs': '${workerUri}' };
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
