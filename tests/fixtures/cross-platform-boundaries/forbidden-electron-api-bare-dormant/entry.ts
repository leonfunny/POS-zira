export function readPrinterOnlyWhenRequested() {
  return electronAPI.printer.getState();
}
