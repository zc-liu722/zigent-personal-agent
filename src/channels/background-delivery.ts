/** Transport acknowledgement stayed ambiguous after the bounded reconciliation window. */
export class BackgroundDeliveryUncertainError extends Error {
  constructor() {
    super("Background delivery could not be confirmed; manual review is required");
    this.name = "BackgroundDeliveryUncertainError";
  }
}
