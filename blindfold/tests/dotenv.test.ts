import { describe, expect, test } from "claude-code/testing";
import type { Entry, Parsed } from "../hooks/dotenv.ts";
import {
	isValidName,
	MAX_FILE_CHARS,
	MAX_VALUE_CHARS,
	MAX_WRITE_CHARS,
	parse,
	setValue,
} from "../hooks/dotenv.ts";
import { parseCases, setValueCases } from "./dotenv-cases.ts";
import { parseExpected, setValueExpected } from "./dotenv-expected.ts";
import { fakes } from "./fakes.ts";

const fake = fakes(11);

const parsed = (text: string): Parsed => {
	const result = parse(text);
	if ("tooLarge" in result) throw new Error("unexpected tooLarge");
	return result;
};

/** What `dotenv.parse` returns: name to value, a later duplicate wins. */
const lastValues = (entries: Entry[]) =>
	Object.fromEntries(entries.map((e) => [e.name, e.value]));

describe("parse", () => {
	test("R1: the saved dotenv results match the cases", () => {
		expect(parseExpected.map((c) => c.input)).toEqual(
			parseCases.map((c) => c.input),
		);
	});

	for (const { input, output } of parseExpected) {
		test(`R1: same result as dotenv 16.6.1 for ${JSON.stringify(input)}`, () => {
			expect(lastValues(parsed(input).entries)).toEqual(output);
		});
	}

	test("R1: badLines holds 1-based line numbers of lines that match no rule", () => {
		expect(parsed("junk\nA=1\n# c\n\n  more junk  \nA:1\n").badLines).toEqual([
			1, 5, 6,
		]);
		expect(parsed("A=1\r\nbad\r\nB=2").badLines).toEqual([2]);
		expect(parsed("# c\n  # d\n\t\n").badLines).toEqual([]);
	});

	test("R1: a span runs from export or the name to the end of the value", () => {
		const text = "# c\r\nexport A=1 # note\r\nB='x\r\ny'\r\nC=\r\n";
		const { entries } = parsed(text);
		expect(entries.map((e) => text.slice(e.start, e.end))).toEqual([
			"export A=1",
			"B='x\r\ny'",
			"C=",
		]);
		expect(entries[1]?.value).toBe("x\ny");
	});

	test("R2: every duplicate is an entry, and its name is listed once", () => {
		const result = parsed("A=1\nB=2\nA=3\nA=4\nB=5\nC=6");
		expect(result.entries.map((e) => `${e.name}=${e.value}`)).toEqual([
			"A=1",
			"B=2",
			"A=3",
			"A=4",
			"B=5",
			"C=6",
		]);
		expect(result.duplicates).toEqual(["A", "B"]);
	});

	test("R3: text longer than MAX_FILE_CHARS is tooLarge", () => {
		expect(MAX_FILE_CHARS).toBe(1_048_576);
		expect(parse("A".repeat(MAX_FILE_CHARS + 1))).toEqual({ tooLarge: true });
		expect("tooLarge" in parse("A".repeat(MAX_FILE_CHARS))).toBe(false);
	});

	test("R3: a file of MAX_FILE_CHARS blank lines parses in under 1 s", () => {
		for (const text of [
			"\n".repeat(MAX_FILE_CHARS),
			`A=${" \n".repeat(MAX_FILE_CHARS / 2 - 2)}`,
			"A\n".repeat(MAX_FILE_CHARS / 2),
		]) {
			const started = performance.now();
			parsed(text);
			const ms = performance.now() - started;
			(globalThis as { console?: { log: (s: string) => void } }).console?.log(
				`R3 parse time: ${ms.toFixed(0)} ms`,
			);
			expect(ms).toBeLessThan(1000);
		}
	});

	test("R8: badLines and duplicates hold no value and no line text", () => {
		const secret = fake.githubClassic;
		const text = `${secret}\nTOKEN=${secret}\nTOKEN='${secret}'\nnot a line ${secret}\n`;
		const result = parsed(text);
		expect(result.entries.map((e) => e.value)).toEqual([secret, secret]);
		const rest = JSON.stringify({
			badLines: result.badLines,
			duplicates: result.duplicates,
			spans: result.entries.map(({ name, start, end }) => [name, start, end]),
		});
		expect(rest.includes(secret)).toBe(false);
		expect(result.badLines).toEqual([1, 4]);
	});
});

const written = (text: string, name: string, value: string): string => {
	const result = setValue(text, name, value);
	if (!result.ok) throw new Error(`unexpected ${result.reason}`);
	return result.text;
};

describe("isValidName", () => {
	test("R4: accepts ^[A-Za-z_][A-Za-z0-9_]{0,63}$ only", () => {
		for (const name of ["A", "_", "a_1", "API_KEY", `A${"B".repeat(63)}`]) {
			expect(isValidName(name)).toBe(true);
		}
		for (const name of [
			"",
			"1A",
			"A-B",
			"A.B",
			"A B",
			"export A",
			"Ä",
			`A${"B".repeat(64)}`,
			"A\n",
		]) {
			expect(isValidName(name)).toBe(false);
		}
	});

	test("F21: refuses __proto__, which dotenv.parse cannot set", () => {
		expect(isValidName("__proto__")).toBe(false);
		expect(setValue("", "__proto__", "x")).toEqual({
			ok: false,
			reason: "bad-name",
		});
	});
});

describe("setValue", () => {
	test("R5: a value without ' or a line break is single-quoted", () => {
		expect(written("", "NAME", 'a $b #c "d" \\e')).toBe(
			"NAME='a $b #c \"d\" \\e'\n",
		);
	});

	test("R5: a value with a newline is double-quoted with \\n", () => {
		expect(written("", "NAME", "line1\nline2\n")).toBe(
			'NAME="line1\\nline2\\n"\n',
		);
	});

	test("R5: a ' with a newline uses the double-quoted form, as the R5 table says", () => {
		expect(written("", "NAME", "it's\nok")).toBe('NAME="it\'s\\nok"\n');
	});

	test("Q21: a value with ' and no newline is written in double quotes", () => {
		expect(written("", "NAME", "it'sMyPass9")).toBe('NAME="it\'sMyPass9"\n');
		expect(written("A=1\n", "NAME", "a'b'c d")).toBe("A=1\nNAME=\"a'b'c d\"\n");
	});

	test("R5: every other value is unsafe-value", () => {
		for (const value of [
			"",
			"it's\"",
			"it's\\",
			"it's$",
			"it's`",
			"a\rb",
			"a\r\nb",
			"a\0b",
			"a\x1bb",
			"a\x7fb",
			"a\x85b",
			'a\nb"',
			"a\nb\\",
			"a\nb$",
			"a\nb`",
		]) {
			expect(setValue("A=1\n", "NAME", value)).toEqual({
				ok: false,
				reason: "unsafe-value",
			});
		}
	});

	test("R6: a bad name is bad-name", () => {
		expect(setValue("", "1A", "x")).toEqual({ ok: false, reason: "bad-name" });
	});

	test("R6: a name that shows twice is duplicate-name", () => {
		expect(setValue("NAME=1\nexport NAME='2'\n", "NAME", "x")).toEqual({
			ok: false,
			reason: "duplicate-name",
		});
	});

	test("R6: a text just below or above MAX_FILE_CHARS is too-large, as it is above MAX_WRITE_CHARS", () => {
		expect(setValue("#".repeat(MAX_FILE_CHARS + 1), "NAME", "x")).toEqual({
			ok: false,
			reason: "too-large",
		});
		expect(setValue("#".repeat(MAX_FILE_CHARS - 4), "NAME", "x")).toEqual({
			ok: false,
			reason: "too-large",
		});
	});

	test("F23: a base text longer than MAX_WRITE_CHARS is too-large", () => {
		const tooLarge = { ok: false, reason: "too-large" };
		expect(MAX_WRITE_CHARS).toBe(131_072);
		const unclosed = `BEFORE=keep\nA='open\n${"F=1\n".repeat(120_000)}AFTER=keep\n`;
		expect(setValue(unclosed, "NAME", "v")).toEqual(tooLarge);
		expect(setValue("#".repeat(MAX_WRITE_CHARS + 1), "NAME", "v")).toEqual(
			tooLarge,
		);
		expect(setValue("#".repeat(MAX_WRITE_CHARS), "NAME", "v").ok).toBe(true);
	});

	test("R6: replace keeps the export prefix, the comment, and the other lines", () => {
		expect(written("# c\nexport  NAME=old # note\nB=2\n", "NAME", "new")).toBe(
			"# c\nexport  NAME='new' # note\nB=2\n",
		);
	});

	test("R6: replace covers every line of a quoted value", () => {
		expect(written('A=1\nNAME="l1\nl2"\nB=2\n', "NAME", "new")).toBe(
			"A=1\nNAME='new'\nB=2\n",
		);
	});

	test("R6: append adds a line break only when the text has none at the end", () => {
		expect(written("", "NAME", "x")).toBe("NAME='x'\n");
		expect(written("A=1", "NAME", "x")).toBe("A=1\nNAME='x'\n");
		expect(written("A=1\n", "NAME", "x")).toBe("A=1\nNAME='x'\n");
		expect(written("# NAME=1\n", "NAME", "x")).toBe("# NAME=1\nNAME='x'\n");
	});

	test("R6: CRLF stays CRLF", () => {
		expect(written("A=1\r\nB=2", "NAME", "x")).toBe(
			"A=1\r\nB=2\r\nNAME='x'\r\n",
		);
		expect(written("A=1\r\nNAME='a\r\nb'\r\nB=2\r\n", "NAME", "x")).toBe(
			"A=1\r\nNAME='x'\r\nB=2\r\n",
		);
	});

	test("F22: append uses CRLF when the text has any CRLF", () => {
		expect(written("A=1\nB=2\r\n", "NAME", "v")).toBe(
			"A=1\nB=2\r\nNAME='v'\r\n",
		);
		expect(written("A=1\nB=2\r\nC=3", "NAME", "v")).toBe(
			"A=1\nB=2\r\nC=3\r\nNAME='v'\r\n",
		);
		expect(written("A=1\rB=2\n", "NAME", "v")).toBe("A=1\rB=2\nNAME='v'\n");
	});

	test("F20: a value longer than MAX_VALUE_CHARS is unsafe-value", () => {
		expect(MAX_VALUE_CHARS).toBe(65_536);
		const unsafe = { ok: false, reason: "unsafe-value" };
		expect(setValue("A=1\n", "NAME", "x".repeat(MAX_VALUE_CHARS + 1))).toEqual(
			unsafe,
		);
		expect(
			setValue("A=1\n", "NAME", `${"x".repeat(MAX_VALUE_CHARS)}\n`),
		).toEqual(unsafe);
		const max = "x".repeat(MAX_VALUE_CHARS);
		expect(written("A=1\n", "NAME", max)).toBe(`A=1\nNAME='${max}'\n`);
	});

	test("F20: a base file with an entry value longer than MAX_VALUE_CHARS is unsafe-value", () => {
		const long = "x".repeat(MAX_VALUE_CHARS + 1);
		const unsafe = { ok: false, reason: "unsafe-value" };
		for (const base of [
			`BEFORE=keep\nA=${long}\nAFTER=keep\n`,
			`BEFORE=keep\nA='${long}'\nINJECT=fake\n`,
			`A="${long}"\n`,
		]) {
			expect(setValue(base, "A", "new")).toEqual(unsafe);
			expect(setValue(base, "NAME", "new")).toEqual(unsafe);
		}
		const max = "x".repeat(MAX_VALUE_CHARS);
		expect(written(`A='${max}'\n`, "NAME", "v")).toBe(`A='${max}'\nNAME='v'\n`);
	});

	test("R6: the byte order mark stays", () => {
		expect(written("\uFEFFNAME=1\n", "NAME", "x")).toBe("\uFEFFNAME='x'\n");
		expect(written("\uFEFFA=1\n", "NAME", "x")).toBe("\uFEFFA=1\nNAME='x'\n");
	});

	test("R7: the saved results match the cases", () => {
		expect(
			setValueExpected.map(({ base, name, value }) => ({ base, name, value })),
		).toEqual(setValueCases);
	});

	setValueExpected.forEach((saved, i) => {
		test(`R7: round trip through dotenv 16.6.1, case ${i}`, () => {
			const result = setValue(saved.base, saved.name, saved.value);
			if (!saved.ok) {
				expect(result).toEqual({ ok: false, reason: saved.reason });
				return;
			}
			expect(result).toEqual({ ok: true, text: saved.text });
			expect(saved.output).toEqual({
				...saved.before,
				[saved.name]: saved.value,
			});
			expect(lastValues(parsed(saved.text).entries)).toEqual(saved.output);
		});
	});

	test("R7: every round-trip pair is written", () => {
		expect(setValueExpected.filter((c) => !c.ok)).toEqual([]);
	});

	test("R7: an output that dotenv reads differently is unsafe-value", () => {
		expect(setValue("X='abc\n", "NAME", "# x")).toEqual({
			ok: false,
			reason: "unsafe-value",
		});
	});

	test("R8: no reason holds the value", () => {
		const secret = fake.stripeSecret;
		const results = [
			setValue("A=1\n", "NAME", `${secret}\r`),
			setValue("A=1\n", "NAME", `${secret}\0`),
			setValue("A=1\n", "NAME", `${secret}'"`),
			setValue("A=1\n", "NAME", `${secret}\n"`),
			setValue(`NAME=${secret}\nNAME=${secret}\n`, "NAME", secret),
			setValue(`X='${secret}\n`, "NAME", `# ${secret}`),
			setValue("", `${secret}-`, secret),
		];
		for (const result of results) {
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result).includes(secret)).toBe(false);
		}
	});
});
