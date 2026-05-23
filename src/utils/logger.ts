import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;
let _reporter: ((message: string) => void) | undefined;

/** Initialise the output channel once during extension activation. */
export function initLogger(context: vscode.ExtensionContext): void {
  _channel = vscode.window.createOutputChannel('Genero BDL Diagram');
  context.subscriptions.push(_channel);
}

/**
 * Register (or clear) the function that forwards log messages to the current
 * `withProgress` reporter, keeping the status-bar notification text in sync.
 * Call `setProgressReporter(undefined)` in the `finally` block after each build.
 *
 * @param cb  Reporter callback, or `undefined` to detach.
 */
export function setProgressReporter(cb: ((message: string) => void) | undefined): void {
  _reporter = cb;
}

/** Reveal the "Genero BDL Diagram" output channel without stealing focus. */
export function showChannel(): void {
  _channel?.show(true);
}

/**
 * Append a timestamped message to the output channel and, when a build is in
 * progress, forward it to the VS Code status-bar notification.
 *
 * @param message  Plain-text message to log.
 */
export function log(message: string): void {
  _channel?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  _reporter?.(message);
}
