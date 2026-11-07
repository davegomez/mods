import type { EngineInterface, ProcessRunResult } from "claude-code";

export type Method = "auto" | "native" | "terminal";
export type Platform = "macos" | "windows" | "linux" | "unknown";
export type Entered =
	| { kind: "value"; value: string }
	| {
			kind: "cancel";
			why: "cancelled" | "timeout" | "unavailable" | "failed";
	  };
export type Route = "native" | "terminal" | "unavailable";
/** R5: what the user typed, and the dots the field shows for it. */
export type Masked = { readonly value: string; readonly shown: string };
export type NativeCommand = {
	argv: string[];
	env?: Record<string, string>;
	/** R2 (F63): the command to try when this one does not start. */
	fallback?: NativeCommand;
};
type NativeOut = Pick<
	ProcessRunResult,
	"exitCode" | "stdout" | "stderr" | "isStdoutTruncated"
>;

/** Q35: off until G2 shows that the host draws the controlled `value` (the dots). */
export const TERMINAL_FIELD = false;
/** R2: a dialog left open this long is killed, and the call rejects. */
export const TIMEOUT_MS = 300_000;
const TITLE = "blindfold";
const DOT = "•";

const cancel = (why: Extract<Entered, { kind: "cancel" }>["why"]): Entered => ({
	kind: "cancel",
	why,
});

/**
 * R1: the method to use. `nativeUnavailable` is true once the native dialog came back `unavailable`.
 * With the terminal field off (Q35), `terminal` acts as `auto`, and every terminal answer is `unavailable`.
 */
export function pickMethod(
	method: Method,
	platform: Platform,
	nativeUnavailable = false,
	terminalField = TERMINAL_FIELD,
): Route {
	const terminal: Route = terminalField ? "terminal" : "unavailable";
	if (method === "terminal" && terminalField) return "terminal";
	if (platform === "unknown")
		return method === "native" ? "unavailable" : terminal;
	if (!nativeUnavailable) return "native";
	return method === "native" || platform === "macos" ? "unavailable" : terminal;
}

/** R2: item 1 is the name, item 2 the reason. Neither is ever in this text. */
const MACOS_SCRIPT = [
	"on run argv",
	"\tactivate",
	`\tset answer to display dialog (item 2 of argv) & linefeed & linefeed & (item 1 of argv) default answer "" with hidden answer with title "${TITLE}" buttons {"Cancel", "Save"} default button "Save" cancel button "Cancel"`,
	"\treturn text returned of answer",
	"end run",
].join("\n");

/** R2: the name and the reason come from BLINDFOLD_NAME and BLINDFOLD_REASON. Cancel writes nothing. */
const WINDOWS_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
	"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
	"$form = New-Object System.Windows.Forms.Form",
	`$form.Text = '${TITLE}'`,
	"$form.FormBorderStyle = 'FixedDialog'",
	"$form.StartPosition = 'CenterScreen'",
	"$form.MinimizeBox = $false",
	"$form.MaximizeBox = $false",
	"$form.TopMost = $true",
	"$form.AutoSize = $true",
	"$form.AutoSizeMode = 'GrowAndShrink'",
	"$panel = New-Object System.Windows.Forms.FlowLayoutPanel",
	"$panel.FlowDirection = 'TopDown'",
	"$panel.AutoSize = $true",
	"$panel.Padding = New-Object System.Windows.Forms.Padding 12",
	"$label = New-Object System.Windows.Forms.Label",
	"$label.AutoSize = $true",
	"$label.MaximumSize = New-Object System.Drawing.Size 400, 0",
	"$label.Text = $env:BLINDFOLD_REASON + [Environment]::NewLine + [Environment]::NewLine + $env:BLINDFOLD_NAME",
	"$box = New-Object System.Windows.Forms.TextBox",
	"$box.UseSystemPasswordChar = $true",
	"$box.Width = 400",
	"$box.AccessibleName = $env:BLINDFOLD_NAME",
	"$buttons = New-Object System.Windows.Forms.FlowLayoutPanel",
	"$buttons.AutoSize = $true",
	"$cancel = New-Object System.Windows.Forms.Button",
	"$cancel.Text = 'Cancel'",
	"$cancel.DialogResult = 'Cancel'",
	"$save = New-Object System.Windows.Forms.Button",
	"$save.Text = 'Save'",
	"$save.DialogResult = 'OK'",
	"$buttons.Controls.AddRange(@($cancel, $save))",
	"$panel.Controls.AddRange(@($label, $box, $buttons))",
	"$form.Controls.Add($panel)",
	"$form.AcceptButton = $save",
	"$form.CancelButton = $cancel",
	"$form.Add_Shown({ $form.Activate(); [void]$box.Focus() })",
	"if ($form.ShowDialog() -eq 'OK') { [Console]::Out.Write($box.Text + [Environment]::NewLine) }",
].join("\n");

/** zenity reads `--text` as Pango markup. */
const escapeMarkup = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * R2: the fixed command for a platform's dialog; `undefined` when there is none.
 * The name and the reason are data: arguments, or env on Windows. Linux needs a display, which the caller checks (F57).
 */
export function nativeCommand(
	platform: Platform,
	name: string,
	reason: string,
): NativeCommand | undefined {
	const prompt = `${reason}\n\n${name}`;
	switch (platform) {
		case "macos":
			return { argv: ["osascript", "-e", MACOS_SCRIPT, "--", name, reason] };
		case "windows":
			return {
				argv: [
					"powershell",
					"-NoProfile",
					"-NonInteractive",
					"-Sta",
					"-Command",
					WINDOWS_SCRIPT,
				],
				env: { BLINDFOLD_NAME: name, BLINDFOLD_REASON: reason },
			};
		case "linux":
			return {
				argv: [
					"zenity",
					"--entry",
					"--hide-text",
					"--title",
					TITLE,
					"--text",
					escapeMarkup(prompt),
				],
				fallback: {
					argv: ["kdialog", "--title", TITLE, "--password", prompt],
				},
			};
		default:
			return undefined;
	}
}

/**
 * R3: the value, or why there is none. Exactly 1 line ending is removed and nothing else (G1).
 * `stderr` only decides a cancel; its text never leaves (it can hold the dialog's text).
 */
export function readNative(platform: Platform, out: NativeOut): Entered {
	if (out.isStdoutTruncated) return cancel("failed");
	if (out.exitCode === 0) {
		const value = out.stdout.replace(
			platform === "windows" ? /\r?\n$/ : /\n$/,
			"",
		);
		return value === "" ? cancel("cancelled") : { kind: "value", value };
	}
	// macOS: osascript prints "execution error: User canceled. (-128)". zenity and kdialog exit 1 on Cancel.
	const cancelled =
		out.exitCode === 1 &&
		((platform === "macos" && out.stderr.includes("(-128)")) ||
			platform === "linux");
	return cancel(cancelled ? "cancelled" : "failed");
}

export const EMPTY_MASK: Masked = { value: "", shown: "" };

/** Counts code points, so a surrogate pair is 1 dot and is removed whole. */
const mask = (chars: string[]): Masked => ({
	value: chars.join(""),
	shown: DOT.repeat(chars.length),
});

/** R5: the next state for the text the field's `onInput` gave. */
export function maskStep(state: Masked, shown: string): Masked {
	if (shown.startsWith(state.shown)) {
		return mask([...state.value, ...shown.slice(state.shown.length)]);
	}
	if (/^•*$/u.test(shown)) return mask([...state.value].slice(0, shown.length));
	return EMPTY_MASK;
}

/** R1: there is no platform API. A failure is `unknown`. */
export async function detectPlatform($: EngineInterface): Promise<Platform> {
	try {
		if ((await $.env.get("OS")) === "Windows_NT") return "windows";
		const { exitCode, stdout } = await $.process.run(["uname", "-s"]);
		if (exitCode !== 0) return "unknown";
		const kernel = stdout.trim();
		return kernel === "Darwin"
			? "macos"
			: kernel === "Linux"
				? "linux"
				: "unknown";
	} catch {
		return "unknown";
	}
}

const isSet = (value: Promise<string | undefined>) =>
	value.then(Boolean, () => false);

/**
 * R2, R3: shows the dialog and returns what it gave. Keeps no copy of the value (R4).
 * A reject at or after the timeout is `timeout`; an earlier one means the program did not start, so its fallback runs (F63).
 */
export async function enterNative(
	$: EngineInterface,
	platform: Platform,
	name: string,
	reason: string,
	now: () => number = () => performance.now(),
): Promise<Entered> {
	if (
		platform === "linux" &&
		!(await isSet($.env.get("DISPLAY"))) &&
		!(await isSet($.env.get("WAYLAND_DISPLAY")))
	) {
		return cancel("unavailable");
	}
	for (
		let command = nativeCommand(platform, name, reason);
		command;
		command = command.fallback
	) {
		const startedAt = now();
		try {
			const out = await $.process.run(command.argv, {
				timeoutMs: TIMEOUT_MS,
				...(command.env ? { env: command.env } : {}),
			});
			return readNative(platform, out);
		} catch {
			if (now() - startedAt >= TIMEOUT_MS) return cancel("timeout");
		}
	}
	return cancel("unavailable");
}
