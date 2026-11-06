// After a change here, run `bun install` and `bun scripts/dotenv-expected.ts` in the repository root.
export type ParseCase = { input: string };
export type SetValueCase = { base: string; name: string; value: string };

/** R1 fixtures, grouped by dialect rule. */
const r1: string[] = [
	// optional leading `export `
	"export A=1",
	"export   A=1",
	"export\tA=1",
	"export\nA=1",
	"export=1",
	"export A",
	// name `[\w.-]+`
	"A.b-c=1",
	"a_1=x",
	"1A=x",
	"A B=1",
	"A$=1",
	"=1",
	// `=` or `: ` with optional spaces
	"A=1",
	"A = 1",
	"A: 1",
	"A :  1",
	"A:1",
	"A\n=1",
	"A:\nB=2",
	// single quotes are literal
	"A='a\\nb $X #c'",
	"A=' x '",
	"A='a\\'b'",
	"A='a\\'",
	"A='x' y",
	"A='x'#c",
	"A='x' # c",
	// double quotes expand \n and \r only
	'A="a\\nb\\rc"',
	'A="a\\tb"',
	'A="a\\"b"',
	'A="x" # c',
	// backticks are literal
	"A=`a\\nb 'q' \"d\"`",
	// quoted values span lines
	"A='a\nb'\nB=2",
	'A="a\nb"\nB=2',
	"A=`a\nb`",
	'A="open\nB=2',
	"A='abc\nNAME='# x'\n",
	'A="x\ny"z\nB=1',
	"A='a\r\nb'",
	// unquoted values end at `#` and are trimmed
	"A=abc #def",
	"A=abc#def",
	"A=  abc  ",
	"A=a b c",
	"A=#x",
	"A= #x",
	"A=\u00a0x\u00a0",
	// empty values
	"A=",
	"A= ",
	"A=''",
	'A=""',
	"A=\nB=2",
	'A=\n"x"',
	// comments and blank lines are skipped
	"# c\nA=1",
	"  # c\n\n\t\nA=1",
	"\n\n\n",
	"#A=1",
	"A=1\n\n\n# c\nB=2",
	// lines that match no rule
	"junk\nA=1\n  more junk  \n",
	"A\nB=1",
	":=1",
	// line endings and the byte order mark
	"A=1\r\nB=2\r\n",
	"A=1\rB=2",
	"\uFEFFA=1",
	"x\u2028A=1",
	// duplicates (R2)
	"A=1\nA=2",
	"A=1\nB=2\nA=3",
];

/** Seeded random inputs from the dialect's special characters, so our parser and dotenv are compared beyond the hand-written fixtures. */
const fuzzParts = [
	"A",
	"B",
	"=",
	":",
	" ",
	"\t",
	"\n",
	"\r",
	"#",
	"'",
	'"',
	"`",
	"\\",
	"n",
	"export ",
	"x",
	"\u2028",
	".",
];
const fuzz = (count: number, seed: number): string[] => {
	let s = seed;
	const next = () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
	return Array.from({ length: count }, () =>
		Array.from(
			{ length: 1 + Math.floor(next() * 20) },
			() => fuzzParts[Math.floor(next() * fuzzParts.length)],
		).join(""),
	);
};

export const parseCases: ParseCase[] = [...r1, ...fuzz(200, 42)].map(
	(input) => ({ input }),
);

/** R5 to R7 round-trip values. */
const values: string[] = [
	"plain-value",
	`a$b\${HOME}$`,
	"a # b#c",
	'say "hi"',
	"a\\b\\",
	"a=b==",
	"  padded  ",
	"a\tb",
	"it'sMyPass9",
	"a'b'c d",
	"héllo ✓ 日本 🙂",
	"-----BEGIN EXAMPLE BLOCK-----\nline one\nline two\n-----END EXAMPLE BLOCK-----\n",
	"abc123-".repeat(586).slice(0, 4096),
];

/** R5 to R7 base files. Each sets `NAME`. */
const bases: string[] = [
	"",
	"A=1\nB=2",
	"A=1\r\nB=2\r\n",
	"\uFEFFA=1\n",
	"# head\nA=1 # note\n\n#NAME=commented\n",
	"export A=1\nexport NAME=old\n",
	'A=1\nNAME="line1\nline2"\nB=2\n',
	"A=1\nNAME=old\nB=2\n",
];

export const setValueCases: SetValueCase[] = bases.flatMap((base) =>
	values.map((value) => ({ base, name: "NAME", value })),
);
