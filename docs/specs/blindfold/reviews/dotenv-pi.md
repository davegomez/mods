# dotenv correctness review: additional findings

This report uses only the completed probes in `/tmp/dotenv-pi-review`, as requested. The already-confirmed large quoted-value and `__proto__` cases are not repeated as findings. No additional parsed-value or injection difference from real dotenv 16.6.1 was confirmed.

## F1. Low: append ignores CRLF when the first line ending is LF

Location: `blindfold/hooks/dotenv.ts:199–201`. Contract: R6.

Trigger:

```ts
setValue("A=1\nB=2\r\n", "NAME", "fake-new")
```

Confirmed result:

```ts
{ ok: true, text: "A=1\nB=2\r\nNAME='fake-new'\n" }
```

The first line ending alone selects the appended line ending. The file contains CRLF, but the new entry ends with LF, contrary to R6's explicit CRLF requirement. Real dotenv still returns `{ A: "1", B: "2", NAME: "fake-new" }`, so this is a formatting-contract failure, not a variable corruption or injection.

Fix: Select CRLF whenever `text.includes("\r\n")`, without changing existing text.

## Evidence and limits

The completed second fuzz run checked 600,265 inputs against real dotenv. Its 84,078 parse-map mismatches all involved the already-known `__proto__` case. With that name excluded as a write target, 539,774 successful writes produced no additional real-dotenv round-trip mismatch. No throws occurred. Saved parse and write fixtures matched their current generated expectations.

The completed adversarial timing probes reached 1,048,576 characters. The slowest measured parse was approximately 95.4 ms, and the slowest measured `setValue` was approximately 94.3 ms. No super-linear slowdown was established. These are bounded probes, not a complexity proof. The plugin test suite was not run, and no new probes were executed after the follow-up instruction.

Verdict: not ready for enroll and write, because the already-confirmed large quoted-value and `__proto__` cases still break real-dotenv parity and the write round-trip guarantee.
