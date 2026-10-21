/** What a number means to the reader: the pane draws good green, bad red, warn yellow. */
export type Tone = "good" | "bad" | "warn";
/** A piece of a line: `bold` sets a value apart, `dim` a label or a caveat. */
export type Run = { text: string; style?: "bold" | "dim"; tone?: Tone };
/** One row of the report: a label in its own column, the runs, and a dim caveat under them. */
export type Line = { label?: string; runs: Run[]; note?: string };
export type Cell = { text: string; tone?: Tone };
export type TableRow = { cells: Cell[]; isPick?: boolean; isCurrent?: boolean };
/** The first column names the row; the others are numbers. */
export type Table = { head: string[]; rows: TableRow[]; legend?: string };
/** `pick` is a recommendation, drawn apart from the rest. */
export type Block = { line: Line } | { table: Table } | { pick: Line };
export type Section = { title: string; blocks: Block[] };

export const bold = (text: string, tone?: Tone): Run =>
	tone === undefined ? { text, style: "bold" } : { text, style: "bold", tone };
export const dim = (text: string): Run => ({ text, style: "dim" });
export const plain = (text: string): Run => ({ text });
export const line = (...runs: Run[]): Block => ({ line: { runs } });
export const pick = (...runs: Run[]): Block => ({ pick: { runs } });
