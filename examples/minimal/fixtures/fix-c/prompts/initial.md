<!-- ael-fake-mode: success -->

`isValidEmail` in `src/validate.mjs` accepts addresses whose domain has no
dot, for example `user@example`. A deliverable address needs a dotted domain.

Do both of the following before claiming the task is done:

1. Fix `isValidEmail` so `user@example` is rejected and `user@example.com` is
   still accepted.
2. Replace the TODO in `tests/validate.test.mjs` with a real regression test
   that asserts `isValidEmail('user@example') === false`.

Run `node --test tests/` and keep it green. Updating only the implementation
is not sufficient.
