import type {
	BoxProps,
	ButtonProps,
	ElementConstructor,
	RenderElement,
	TextProps,
} from "claude-code";

import type {
	Block,
	Cell,
	Line,
	Run,
	Section,
	Table,
	Tone,
} from "./sections.ts";

type Elements = {
	Box: ElementConstructor<BoxProps>;
	Button: ElementConstructor<ButtonProps>;
	Text: ElementConstructor<TextProps>;
};

export type Tab = {
	key: string;
	label: string;
	hotkey: string;
	isActive: boolean;
	onPress: () => void;
};

/** A pane: its title, the tabs when there is a choice, the sections, and what the Close button does. */
export type PaneView = {
	title: string;
	tabs?: readonly Tab[];
	sections: readonly Section[];
	onClose: () => void;
};

/** Theme keys, so the colors follow the person's theme. */
const COLOR: Record<Tone, string> = {
	good: "success",
	bad: "error",
	warn: "warning",
};
/** Fits the longest label, `Idle compaction`, and a gap. */
const LABEL_WIDTH = 17;

const paint = (tone?: Tone, isBold = false, isDim = false): TextProps => ({
	...(tone === undefined ? {} : { color: COLOR[tone] }),
	...(isBold ? { weight: "bold" as const } : {}),
	...(isDim ? { dimColor: true } : {}),
});

/** Each column as wide as its widest cell, so a table needs no more room than its text. */
export const columnWidths = (t: Table): number[] =>
	t.head.map((h, i) =>
		Math.max(h.length, ...t.rows.map((r) => r.cells[i]?.text.length ?? 0)),
	);

/**
 * An ember pane: a header row (title, tabs, Close), any untitled section under it, then the titled sections side by
 * side, wrapping to the next row where the pane is too narrow; each section a bold title, label/value rows, `Box`
 * tables, a recommendation boxed as wide as its text.
 */
export function pane(
	{ title, tabs = [], sections, onClose }: PaneView,
	{ Box, Button, Text }: Elements,
): RenderElement {
	const runs = (rs: readonly Run[]) =>
		rs.map((r) => (
			<Text {...paint(r.tone, r.style === "bold", r.style === "dim")}>
				{r.text}
			</Text>
		));

	const line = (l: Line) => (
		<Box flexDirection="column">
			<Box flexDirection="row">
				{l.label === undefined ? null : (
					<Box width={LABEL_WIDTH} flexShrink={0}>
						<Text dimColor>{l.label}</Text>
					</Box>
				)}
				<Text>{runs(l.runs)}</Text>
			</Box>
			{l.note === undefined ? null : (
				<Box paddingLeft={l.label === undefined ? 0 : LABEL_WIDTH}>
					<Text dimColor>{l.note}</Text>
				</Box>
			)}
		</Box>
	);

	const table = (t: Table) => {
		const widths = columnWidths(t);
		const hasMarks = t.rows.some(
			(r) => r.isPick === true || r.isCurrent === true,
		);
		// The name column gives way first in a narrow pane; the numbers keep their width.
		const row = (
			cells: readonly Cell[],
			isBold: boolean,
			mark: RenderElement,
		) => (
			<Box flexDirection="row" gap={2}>
				{hasMarks ? (
					<Box width={1} flexShrink={0}>
						{mark}
					</Box>
				) : null}
				{cells.map((c, i) => (
					<Box
						width={widths[i] ?? 0}
						flexShrink={i === 0 ? 1 : 0}
						justifyContent={i === 0 ? "flex-start" : "flex-end"}
					>
						<Text
							wrap="truncate-end"
							tabular={i > 0}
							{...paint(c.tone, isBold)}
						>
							{c.text}
						</Text>
					</Box>
				))}
			</Box>
		);
		return (
			<Box flexDirection="column">
				{row(
					t.head.map((text) => ({ text })),
					true,
					<Text> </Text>,
				)}
				{t.rows.map((r) =>
					row(
						r.cells,
						r.isPick === true,
						r.isPick === true ? (
							<Text weight="bold" color="suggestion">
								▸
							</Text>
						) : r.isCurrent === true ? (
							<Text weight="bold">•</Text>
						) : (
							<Text> </Text>
						),
					),
				)}
				{t.legend === undefined ? null : <Text dimColor>{t.legend}</Text>}
			</Box>
		);
	};

	const block = (b: Block) =>
		"table" in b ? (
			table(b.table)
		) : "pick" in b ? (
			<Box
				borderStyle="round"
				borderColor="suggestion"
				paddingX={1}
				alignSelf="flex-start"
			>
				<Text>{runs(b.pick.runs)}</Text>
			</Box>
		) : (
			line(b.line)
		);

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="row" justifyContent="space-between" gap={2}>
				<Box flexDirection="row" gap={2}>
					<Text weight="bold" color="claude">
						{title}
					</Text>
					{tabs.map((t) => (
						<Button
							key={t.key}
							label={t.label}
							hotkey={t.hotkey}
							plain
							dimColor={!t.isActive}
							onPress={t.onPress}
						/>
					))}
				</Box>
				{/* biome-ignore lint/a11y/useValidAriaRole: the engine's Button role, not ARIA; a desktop draws its native close control. */}
				<Button
					key="close"
					label="Close"
					hotkey="q"
					plain
					role="dismiss"
					onPress={onClose}
				/>
			</Box>
			{sections
				.filter((s) => s.title === undefined)
				.map((s) => (
					<Box flexDirection="column">{s.blocks.map(block)}</Box>
				))}
			<Box flexDirection="row" flexWrap="wrap" columnGap={4} rowGap={1}>
				{sections
					.filter((s) => s.title !== undefined)
					.map((s) => (
						<Box flexDirection="column">
							<Text weight="bold" color="claude">
								{s.title}
							</Text>
							{s.blocks.map(block)}
						</Box>
					))}
			</Box>
		</Box>
	);
}
