// Compatibility shim for the experimental Integrated Browser/CDP branch.
// Existing call sites still import WebSocketManager, but no WebSocket server or
// browser extension is used by this implementation.
export { IntegratedBrowserManager as WebSocketManager } from './integrated-browser-manager'
