import { pathToFileURL } from 'node:url';

const FREEZING_POINT_F = 32;

/** 100 °C => 212 °F */
export function celsiusToFahrenheit(celsius) {
  return (celsius * 9) / 5 - FREEZING_POINT_F;
}

/** 212 °F => 100 °C */
export function fahrenheitToCelsius(fahrenheit) {
  return ((fahrenheit - FREEZING_POINT_F) * 5) / 9;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [direction, value] = process.argv.slice(2);
  const input = Number(value);
  if (direction === 'c2f') {
    console.log(String(celsiusToFahrenheit(input)));
  } else if (direction === 'f2c') {
    console.log(String(fahrenheitToCelsius(input)));
  } else {
    console.error('usage: node src/temperature.mjs <c2f|f2c> <value>');
    process.exit(2);
  }
}
