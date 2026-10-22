import type { Block, Line, Section } from "../hooks/sections.ts";

/** A line as plain text: `label: ` then the runs, then the caveat after a space. */
export const lineText = (l: Line) =>
	`${l.label === undefined ? "" : `${l.label}: `}${l.runs.map((r) => r.text).join("")}${l.note === undefined ? "" : ` ${l.note}`}`;
const rowText = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
const blockText = (b: Block) =>
	"table" in b
		? [
				rowText(b.table.head),
				...b.table.rows.map((r) => rowText(r.cells.map((c) => c.text))),
			].join("\n")
		: lineText("line" in b ? b.line : b.pick);
/** The report as plain text, one row per line, each section under its title if it has one. */
export const textOf = (sections: readonly Section[]) =>
	sections
		.flatMap((s) => [
			...(s.title === undefined ? [] : [s.title]),
			...s.blocks.map(blockText),
		])
		.join("\n");

type El = {
	type: string;
	props?: Record<string, string | number | boolean>;
	children?: unknown[];
};

const isEl = (n: unknown): n is El =>
	typeof n === "object" && n !== null && "type" in n;
const kids = (n: El) => (n.children ?? []).flat(Infinity as 1);
const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** A plain Button reads `hotkey: label`, as the terminal draws it. */
const button = (p: El["props"] = {}) =>
	p.plain === true && p.hotkey !== undefined
		? `${p.hotkey}: ${p.label}`
		: String(p.label);

/** A Text's words: its strings and those of the Texts inside it. */
const inline = (n: unknown): string =>
	typeof n === "string" || typeof n === "number"
		? String(n)
		: isEl(n)
			? n.type === "Button"
				? button(n.props)
				: kids(n).map(inline).join("")
			: "";
const isLeaf = (n: El) => n.type === "Text" || n.type === "Button";
/** A row that wraps holds blocks, read one under the other. */
const isLine = (p: El["props"] = {}) =>
	p.flexDirection === "row" && p.flexWrap !== "wrap";

/** The drawing as text to search: a row's parts joined by a space, a column's by a line break. */
export function flat(n: unknown): string {
	if (!isEl(n)) return inline(n);
	if (isLeaf(n)) return inline(n);
	const parts = kids(n)
		.map(flat)
		.filter((s) => s !== "");
	return parts.join(isLine(n.props) ? " " : "\n");
}

const wrap = (text: string, width: number): string[] => {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		let row = "";
		for (const word of para.split(" ")) {
			const next = row === "" ? word : `${row} ${word}`;
			if (next.length <= width || row === "") row = next;
			else {
				out.push(row);
				row = word;
			}
		}
		out.push(row);
	}
	return out;
};
const cut = (text: string, width: number) =>
	text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

const widest = (lines: readonly string[]) =>
	Math.max(0, ...lines.map((l) => l.length));

/** Blocks side by side, each padded to its width, `gap` spaces apart. */
const beside = (
	blocks: readonly string[][],
	widths: readonly number[],
	gap = 0,
) =>
	Array.from({ length: Math.max(...blocks.map((b) => b.length)) }, (_, row) =>
		blocks
			.map((b, i) => (b[row] ?? "").padEnd(widths[i] ?? 0))
			.join(" ".repeat(gap))
			.trimEnd(),
	);

/**
 * shortcut: an approximation of the terminal's layout (word wrap, fixed widths, gaps, flex wrap, space-between,
 * round borders), not the engine's paint, which the test kit does not run; enough to read the pane and check that
 * a row fits its width.
 */
export function layout(n: unknown, width: number): string[] {
	if (!isEl(n)) return wrap(inline(n), width);
	if (n.type === "Button") return [cut(inline(n), width)];
	if (n.type === "Text")
		return n.props?.wrap === "truncate-end"
			? [cut(inline(n), width)]
			: wrap(inline(n), width);
	const p = n.props ?? {};
	const border = p.borderStyle === undefined ? 0 : 1;
	const padX = num(p.paddingX);
	const inner = Math.max(1, width - 2 * border - 2 * padX - num(p.paddingLeft));
	const children = kids(n).filter((k) => k !== null && k !== undefined);
	const gap = num(p.gap);
	let lines: string[];
	if (p.flexDirection === "row" && p.flexWrap === "wrap") {
		// Each child at its own width, on the row while it fits, else on the next.
		const colGap = num(p.columnGap);
		const rows: string[][][] = [];
		let used = 0;
		for (const block of children.map((k) => layout(k, inner))) {
			const w = widest(block);
			const last = rows.at(-1);
			if (last === undefined || used + colGap + w > inner) {
				rows.push([block]);
				used = w;
			} else {
				last.push(block);
				used += colGap + w;
			}
		}
		lines = rows.flatMap((r, i) => [
			...(i > 0 ? Array.from({ length: num(p.rowGap) }, () => "") : []),
			...beside(r, r.map(widest), colGap),
		]);
	} else if (p.flexDirection === "row") {
		const fixed = children.map((k) =>
			isEl(k) && typeof k.props?.width === "number" ? k.props.width : undefined,
		);
		const used =
			fixed.reduce<number>((s, w) => s + (w ?? 0), 0) +
			gap * (children.length - 1);
		const excess = used - inner;
		const shrink = children.findIndex(
			(k) => isEl(k) && k.props?.flexShrink === 1,
		);
		const free = Math.max(1, inner - used);
		const cols = children.map((k, i) => {
			const w = fixed[i];
			return layout(
				k,
				w === undefined
					? free
					: i === shrink && excess > 0
						? Math.max(1, w - excess)
						: w,
			);
		});
		// A box without a width is as wide as its text.
		const widths = cols.map((c, i) => {
			const w = fixed[i];
			return w === undefined
				? widest(c)
				: i === shrink && excess > 0
					? Math.max(1, w - excess)
					: w;
		});
		const aligned = cols.map((c, i) => {
			const kid = children[i];
			const right = isEl(kid) && kid.props?.justifyContent === "flex-end";
			return right ? c.map((l) => l.padStart(widths[i] ?? 0)) : c;
		});
		const spare = Math.max(
			0,
			inner - widths.reduce((s, w) => s + w, 0) - gap * (children.length - 1),
		);
		// space-between: the spare room goes between the first child and the rest.
		if (p.justifyContent === "space-between" && widths.length > 1)
			widths[0] = (widths[0] ?? 0) + spare;
		lines = beside(aligned, widths, gap);
	} else {
		lines = children.flatMap((k, i) => [
			...(i > 0 ? Array.from({ length: gap }, () => "") : []),
			...layout(k, inner),
		]);
	}
	const lead = " ".repeat(num(p.paddingLeft) + padX);
	lines = lines.map((l) => (l === "" ? l : lead + l));
	if (border === 0) return lines;
	const w = Math.min(width - 2, Math.max(...lines.map((l) => l.length)) + padX);
	return [
		`╭${"─".repeat(w)}╮`,
		...lines.map((l) => `│${l.padEnd(w)}│`),
		`╰${"─".repeat(w)}╯`,
	];
}
