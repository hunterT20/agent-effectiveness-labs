import { pathToFileURL } from 'node:url';

/**
 * Apply a percentage discount to a price.
 *
 *   applyDiscount(200, 25) // => 150
 *   applyDiscount(80, 0)   // => 80
 */
export function applyDiscount(price, percent) {
  if (percent < 0 || percent > 100) {
    throw new RangeError('percent must be between 0 and 100');
  }
  return price - percent;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [price, percent] = process.argv.slice(2).map(Number);
  console.log(String(applyDiscount(price, percent)));
}
