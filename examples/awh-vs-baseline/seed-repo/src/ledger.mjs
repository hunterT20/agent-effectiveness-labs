export class Ledger {
  constructor() {
    this._entries = [];
  }

  add(amountCents, _category) {
    this._entries.push({ amountCents });
  }

  entries() {
    return this._entries.slice();
  }
}
