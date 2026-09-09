# shop-utils

Tiny ESM utility library used as the seed project for Agent Effectiveness Labs fixtures.

| Module                | Purpose                            |
| --------------------- | ---------------------------------- |
| `src/discount.mjs`    | Percentage discounts               |
| `src/temperature.mjs` | Celsius / Fahrenheit conversion    |
| `src/validate.mjs`    | Input validation helpers           |

Modules can be run directly from the command line, for example:

```sh
node src/discount.mjs 200 25
node src/temperature.mjs c2f 100
```

Run the test suite with `node --test tests/`.
