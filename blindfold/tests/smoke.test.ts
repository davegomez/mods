import type { EngineInterface, PluginOptions } from "claude-code";
import { describe, expect, test } from "claude-code/testing";
import { DEFAULT_LIMITS, scanText } from "../hooks/detect.ts";
import { addFile } from "../hooks/enroll.ts";
import { enrollment, register } from "../hooks/register.ts";
import {
	type FakeFile,
	fakeApi,
	fakes,
	type Hook,
	hooksOf as hooksOfModule,
	REAL_ROOT,
	stubFs,
} from "./fakes.ts";

const fake = fakes(31);
const never = { now: () => 0, deadline: Number.POSITIVE_INFINITY };

const hooksOf = (options: PluginOptions) => hooksOfModule(register, options);

/** Runs 1 hook with a `next` that calls `atNext`, then answers `answer`. Returns what the hook returned and what `next` got. */
const run = async (
	hook: Hook | undefined,
	$: EngineInterface,
	e: unknown,
	atNext = () => {},
) => {
	const answer = { from: "next" };
	const passed: unknown[] = [];
	const result = await hook?.($, e, async (given) => {
		atNext();
		passed.push(given);
		return answer;
	});
	return { result, answer, passed };
};

const hides = (value: string) => {
	const result = scanText(
		`out ${value} end`,
		enrollment.knownSet(),
		DEFAULT_LIMITS,
		never,
	);
	return (
		result.status === "found" && result.hits.some((hit) => hit.kind === "known")
	);
};

const secretFile = (value: string): FakeFile => ({
	text: `API_KEY=${value}\n`,
});

describe("R7 lifecycle wiring", () => {
	test("R7, R3 to R14, request R1: register hooks the lifecycle events, each guard event with a .catch and no matcher, and request_secret after the tool.call guard", () => {
		expect([...hooksOf({ envFiles: ".env" }).keys()]).toEqual([
			"session.start",
			"classic.SessionStart",
			"classic.SessionStart.catch",
			"session.end",
			"tool.call",
			"tool.call.catch",
			'tool.call {"tool":"mcp__blindfold__request_secret"}',
			"prompt.submit",
			"prompt.submit.catch",
			"prompt.context",
			"prompt.context.catch",
			"prompt.section",
			"prompt.section.catch",
			"prompt.attachment",
			"prompt.attachment.catch",
			"skill.prompt",
			"skill.prompt.catch",
			"prompt.mention",
			"prompt.mention.catch",
			"agent.spawn",
			"agent.spawn.catch",
			"session.send",
			"session.send.catch",
			"session.receive",
			"session.receive.catch",
			"session.append",
			"session.append.catch",
			"config.set",
		]);
	});

	test("R4: the registered tool.call hook refuses a value of the module's enrollment", async () => {
		enrollment.drop();
		const value = fake.secret(24);
		const { api } = fakeApi({ ".env": secretFile(value) });
		const hooks = hooksOf({ envFiles: ".env" });
		await run(hooks.get("session.start"), api, {});
		let ran = false;
		const next = Object.assign(
			async () => {
				ran = true;
				return {};
			},
			{ budget: { ms: 10_000, remainingMs: 10_000 } },
		);
		const result = await hooks.get("tool.call")?.(
			api,
			{ tool: "Bash", command: `echo ${value}` },
			next,
		);
		expect(Object.keys(result as object)).toEqual(["deny"]);
		expect(ran).toBe(false);
	});

	test("R7 (F24): a classic.SessionStart hook that fails still calls next", async () => {
		const handler = hooksOf({ envFiles: ".env" }).get(
			"classic.SessionStart.catch",
		);
		const { api } = fakeApi({});
		const e = { source: "clear" };
		const { result, answer, passed } = await run(handler, api, e);
		expect(result).toBe(answer);
		expect(passed[0]).toBe(e);
	});

	for (const ended of [true, false]) {
		test(`R7 (F24): ${ended ? "session.end, then " : ""}classic.SessionStart from clear loads the list that addFile changed`, async () => {
			enrollment.drop();
			const added = fake.secret(24);
			const { api } = fakeApi({
				".env": secretFile(fake.secret(24)),
				"a.env": secretFile(added),
			});
			const hooks = hooksOf({ envFiles: ".env" });
			await run(hooks.get("session.start"), api, {});
			expect(await addFile(api, enrollment, "a.env")).toBe("added");
			if (ended) await run(hooks.get("session.end"), api, { reason: "clear" });
			await run(hooks.get("classic.SessionStart"), api, { source: "clear" });
			expect(enrollment.status().files.map((f) => f.path)).toEqual([
				".env",
				"a.env",
			]);
			expect(hides(added)).toBe(true);
		});
	}

	test("R7 (F32): session.start loads the envFiles list before next, then returns next(e) unchanged", async () => {
		enrollment.drop();
		const value = fake.secret(24);
		const { api } = fakeApi({ ".env": secretFile(value) });
		const e = { cwd: "/repo" };
		const hook = hooksOf({ envFiles: ".env,b.env" }).get("session.start");
		let hiddenAtNext = false;
		const { result, answer, passed } = await run(hook, api, e, () => {
			hiddenAtNext = hides(value);
		});
		expect(hiddenAtNext).toBe(true);
		expect(result).toBe(answer);
		expect(passed).toEqual([e]);
		expect(passed[0]).toBe(e);
		expect(enrollment.status().files.map((f) => f.path)).toEqual([
			".env",
			"b.env",
		]);
		expect(hides(value)).toBe(true);
	});

	test("R7: a list that is not a string falls back to .env", async () => {
		enrollment.drop();
		const { api } = fakeApi({});
		await run(hooksOf({}).get("session.start"), api, {});
		expect(enrollment.status().files.map((f) => f.path)).toEqual([".env"]);
	});

	for (const source of ["clear", "resume", "fork"]) {
		test(`R7: classic.SessionStart from ${source} drops every value, then loads`, async () => {
			enrollment.drop();
			const old = fake.secret(24);
			const value = fake.secret(24);
			enrollment.learn("old.env", "OLD_TOKEN", old);
			const { api } = fakeApi({ ".env": secretFile(value) });
			const e = { source };
			const hook = hooksOf({ envFiles: ".env" }).get("classic.SessionStart");
			const { result, answer, passed } = await run(hook, api, e);
			expect(result).toBe(answer);
			expect(passed[0]).toBe(e);
			expect(hides(old)).toBe(false);
			expect(hides(value)).toBe(true);
		});
	}

	for (const source of ["startup", "compact"]) {
		test(`R7: classic.SessionStart from ${source} keeps the values and reads nothing`, async () => {
			enrollment.drop();
			const old = fake.secret(24);
			enrollment.learn(".env", "OLD_TOKEN", old);
			const { api, reads } = fakeApi({ ".env": secretFile(fake.secret(24)) });
			const hook = hooksOf({ envFiles: ".env" }).get("classic.SessionStart");
			const { result, answer } = await run(hook, api, { source });
			expect(result).toBe(answer);
			expect(reads).toEqual([]);
			expect(hides(old)).toBe(true);
		});
	}

	test("R7: session.end drops every value and file, then returns next(e) unchanged", async () => {
		enrollment.drop();
		const value = fake.secret(24);
		const { api } = fakeApi({ ".env": secretFile(value) });
		const hooks = hooksOf({ envFiles: ".env" });
		await run(hooks.get("session.start"), api, {});
		const e = { reason: "other" };
		const { result, answer, passed } = await run(
			hooks.get("session.end"),
			api,
			e,
		);
		expect(result).toBe(answer);
		expect(passed[0]).toBe(e);
		expect(hides(value)).toBe(false);
		expect(enrollment.status()).toEqual({ files: [], shield: "active" });
	});
});

describe("R7 the loaded mod", () => {
	test(
		"R7: the mod's session.start reads the listed files through its own $",
		{ options: { envFiles: ".env,b.env" } },
		async ($, on) => {
			const { api, reads } = fakeApi({
				".env": secretFile(fake.secret(24)),
				"b.env": secretFile(fake.secret(24)),
			});
			stubFs(on, api);
			on("session.start", () => ({ cwd: "/repo" }));
			const result = await $.session.start({
				surface: "terminal",
				isInteractive: true,
				cwd: "/repo",
			});
			expect(result).toEqual({ cwd: "/repo" });
			expect([...reads].sort()).toEqual([
				`${REAL_ROOT}/.env`,
				`${REAL_ROOT}/b.env`,
			]);
		},
	);

	test("R7: the manifest's default list is .env", async ($, on) => {
		const { api, reads } = fakeApi({ ".env": secretFile(fake.secret(24)) });
		stubFs(on, api);
		on("session.start", () => ({ cwd: "/repo" }));
		await $.session.start({
			surface: "terminal",
			isInteractive: true,
			cwd: "/repo",
		});
		expect(reads).toEqual([`${REAL_ROOT}/.env`]);
	});

	test("R7: the mod's classic.SessionStart reads again on clear, not on startup", async ($, on) => {
		const { api, reads } = fakeApi({ ".env": secretFile(fake.secret(24)) });
		stubFs(on, api);
		on("classic.SessionStart", () => ({}));
		await $.classic.SessionStart({ source: "startup" });
		expect(reads).toEqual([]);
		await $.classic.SessionStart({ source: "clear" });
		expect(reads).toEqual([`${REAL_ROOT}/.env`]);
	});
});
