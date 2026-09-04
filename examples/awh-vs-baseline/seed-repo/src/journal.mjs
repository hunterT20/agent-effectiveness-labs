export class Journal {
  constructor() {
    this._items = [];
    this._nextId = 1;
  }

  add(amountCents) {
    const id = this._nextId;
    this._nextId += 1;
    this._items.push({ id, amountCents });
    return id;
  }

  items() {
    return this._items.map((item) => ({ ...item }));
  }

  totalCents() {
    return this._items.reduce((sum, item) => sum + item.amountCents, 0);
  }
}
