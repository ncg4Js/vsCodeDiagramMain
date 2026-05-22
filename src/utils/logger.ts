import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;
let _reporter: ((message: string) => void) | undefined;

/** Initialise the output channel once during extension activation. */
export function initLogger(context: vscode.ExtensionContext): void {
  _channel = vscode.window.createOutputChannel('Genero App Diagram');
  context.subscriptions.push(_channel);
}

/**
 * Register (or clear) the function that forwards log messages to the current
 * withProgress reporter so the status-bar notification text stays in sync.
 * Call setProgressReporter(undefined) in the finally block after each build.
 */
export function setProgressReporter(cb: ((message: string) => void) | undefined): void {
  _reporter = cb;
}

/**
 * Central log function used by all extension layers.
 * Writes to the "Genero App Diagram" OUTPUT channel and, when a build is
 * in progress, updates the VS Code status-bar notification message.
 */
export function showChannel(): void {
  _channel?.show(true);
}

export function log(message: string): void {
  _channel?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  _reporter?.(message);
}
