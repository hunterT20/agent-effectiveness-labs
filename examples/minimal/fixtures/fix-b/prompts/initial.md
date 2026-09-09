<!-- ael-fake-mode: success -->

`celsiusToFahrenheit` in `src/temperature.mjs` uses the wrong sign for the
freezing-point offset. `celsiusToFahrenheit(100)` should be `212`, and
`celsiusToFahrenheit(0)` should be `32`.

`fahrenheitToCelsius` is already correct (`fahrenheitToCelsius(212) === 100`).
Do not change its formula. A "cleanup" that rewrites both converters is a
regression.
